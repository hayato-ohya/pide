import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { IDockviewPanelProps } from "dockview";
import { readText, savePath, writeText } from "../fs";
import { marked } from "marked";
import { execute, interrupt, registerDisplay, type OutputItem } from "../kernel";
import { appendStreamText, pushConsole, set as setStore, setDirtyPanel, streamDisplay, useStore } from "../store";
import { Output, ansi } from "./Console";
import { safeHtml } from "../sanitize";
import { changeNotebookCell, closeNotebookDoc, formatDocument, openNotebookDoc, queueDocumentChange, syncNotebookStructure } from "../lsp";
import { debugCell, editorPathFor, syncBreakpointLines, toggleBreakpoint, type Breakpoint } from "../debug";
import { confirmAsync } from "../dialogs";
import { reloaders } from "../reload";
import { bpTitle } from "./Editor";
import { scheduleLint } from "../tools";

// ------------------------------------------------------------ nbformat --

type Mime = Record<string, unknown>;
type NbOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "execute_result"; data: Mime; metadata: Mime; execution_count: number | null }
  | { output_type: "display_data"; data: Mime; metadata: Mime }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

interface Cell {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string;
  metadata: Mime;
  execution_count?: number | null;
  outputs?: NbOutput[];
  /** The cell as read from disk; unknown fields (attachments, ...) survive a save. */
  raw?: Record<string, unknown>;
  /** UI only */
  editing?: boolean;
  running?: boolean;
  /** Output collapsed (persisted as metadata.collapsed + jupyter.outputs_hidden). */
  collapsed?: boolean;
}

interface Notebook { cells: Cell[]; metadata: Mime; nbformat: number; nbformat_minor: number; /** unknown top-level fields */ extra?: Record<string, unknown> }

const uid = () => Math.random().toString(36).slice(2, 10);
const joinSrc = (s: unknown) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
const splitSrc = (s: string) => { const lines = s.split("\n"); return lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l)).filter((l, i, a) => !(i === a.length - 1 && l === "")); };

/** nbformat: `application/json` and `application/*+json` values are JSON as is (object, list,
 * string), never a multiline string split into lines. */
const isJsonMime = (k: string) => /^application\/(.*\+)?json$/.test(k);

/** Cap on one stream output of a cell (the console has its own): a runaway print loop must
 * not grow the notebook, and its re-rendering, without bound.  The tail is kept. */
const MAX_CELL_STREAM = 1024 * 1024;
const TRUNCATED = "[… earlier output truncated …]\n";
function capStream(text: string): string {
  if (text.length <= MAX_CELL_STREAM) return text;
  const body = text.startsWith(TRUNCATED) ? text.slice(TRUNCATED.length) : text;
  const from = body.length - MAX_CELL_STREAM / 2;
  const nl = body.indexOf("\n", from);
  return TRUNCATED + body.slice(nl >= 0 ? nl + 1 : from);
}

function parseNotebook(text: string): Notebook {
  const nb = text.trim() ? JSON.parse(text) : {};
  const cells: Cell[] = (nb.cells ?? []).map((c: any) => ({
    id: c.id ?? uid(),
    raw: c,
    cell_type: c.cell_type ?? "code",
    source: joinSrc(c.source),
    metadata: c.metadata ?? {},
    execution_count: c.execution_count ?? null,
    collapsed: !!(c.metadata?.collapsed || c.metadata?.jupyter?.outputs_hidden),
    outputs: (c.outputs ?? []).map((o: any) => (o.output_type === "stream" ? { ...o, text: joinSrc(o.text) } : o.output_type === "error" ? o : { ...o, data: Object.fromEntries(Object.entries(o.data ?? {}).map(([k, v]) => [k, isJsonMime(k) ? v : Array.isArray(v) ? v.join("") : v])) })),
  }));
  if (!cells.length) cells.push({ id: uid(), cell_type: "code", source: "", metadata: {}, execution_count: null, outputs: [] });
  return { cells, metadata: nb.metadata ?? { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, nbformat: nb.nbformat ?? 4, nbformat_minor: nb.nbformat_minor ?? 5, extra: Object.fromEntries(Object.entries(nb).filter(([k]) => !["cells", "metadata", "nbformat", "nbformat_minor"].includes(k))) };
}

function serializeNotebook(nb: Notebook): string {
  const cells = nb.cells.map((c) => {
    const metadata: any = { ...c.metadata };
    if (c.cell_type === "code") {
      if (c.collapsed) { metadata.collapsed = true; metadata.jupyter = { ...(metadata.jupyter ?? {}), outputs_hidden: true }; }
      else { delete metadata.collapsed; if (metadata.jupyter) { delete metadata.jupyter.outputs_hidden; if (!Object.keys(metadata.jupyter).length) delete metadata.jupyter; } }
    }
    const base: any = { ...c.raw, cell_type: c.cell_type, id: c.id, metadata, source: splitSrc(c.source) };
    if (c.cell_type !== "code") { delete base.execution_count; delete base.outputs; }
    if (c.cell_type === "code") {
      base.execution_count = c.execution_count ?? null;
      base.outputs = (c.outputs ?? []).map((o) => {
        if (o.output_type === "stream") return { output_type: "stream", name: o.name, text: splitSrc(o.text) };
        if (o.output_type === "error") return o;
        const data = Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, typeof v === "string" && !k.startsWith("image/") && !isJsonMime(k) ? splitSrc(v) : v]));
        const { display_id: _transient, ...metadata } = (o.metadata ?? {}) as Mime; // display_id is runtime-only
        return o.output_type === "execute_result" ? { output_type: "execute_result", data, metadata, execution_count: o.execution_count ?? null } : { output_type: "display_data", data, metadata };
      });
    }
    return base;
  });
  // Cell ids are written, which needs nbformat >= 4.5.
  const minor = nb.nbformat === 4 ? Math.max(5, nb.nbformat_minor) : nb.nbformat_minor;
  return JSON.stringify({ ...nb.extra, cells, metadata: nb.metadata, nbformat: nb.nbformat, nbformat_minor: minor }, null, 1) + "\n";
}

/** Apply a kernel output item to a cell's output list (nbformat shape). */
function applyOutput(outputs: NbOutput[], it: OutputItem): NbOutput[] {
  switch (it.kind) {
    case "clear": return [];
    case "stream": {
      const last = outputs[outputs.length - 1];
      if (last && last.output_type === "stream" && last.name === it.name) return [...outputs.slice(0, -1), { ...last, text: capStream(appendStreamText(last.text, it.text)) }];
      return [...outputs, { output_type: "stream", name: it.name, text: capStream(appendStreamText("", it.text)) }];
    }
    case "result": return [...outputs, { output_type: "execute_result", data: it.data, metadata: {}, execution_count: it.count }];
    case "display": {
      if (it.update && it.displayId) {
        const i = outputs.findIndex((o) => o.output_type === "display_data" && (o.metadata as any)?.display_id === it.displayId);
        // Updates only replace: an unknown display_id is another cell's (or gone), never a new output.
        return i >= 0 ? outputs.map((o, j) => (j === i ? { ...o, data: it.data } : o)) : outputs;
      }
      return [...outputs, { output_type: "display_data", data: it.data, metadata: it.displayId ? { display_id: it.displayId } : {} }];
    }
    case "error": return [...outputs, { output_type: "error", ename: it.ename, evalue: it.evalue, traceback: it.traceback }];
    default: return outputs;
  }
}

// --------------------------------------------------------------- cells --

const AUTO_COLLAPSE_LINES = 40;
function outputLines(outputs: NbOutput[]) {
  return outputs.reduce((n, o) => n + (o.output_type === "stream" ? o.text.split("\n").length : o.output_type === "error" ? o.traceback.length : 1), 0);
}

function CellOutputs({ outputs, collapsed, onToggle }: { outputs: NbOutput[]; collapsed: boolean; onToggle: () => void }) {
  const [expandedLong, setExpandedLong] = useState(false);
  const lines = useMemo(() => outputLines(outputs), [outputs]);
  if (!outputs.length) return null;
  const long = lines > AUTO_COLLAPSE_LINES && !expandedLong;
  const summary = outputs.map((o) => (o.output_type === "stream" ? o.name : o.output_type === "error" ? `error: ${o.ename}` : o.output_type === "execute_result" ? "result" : Object.keys(o.data).some((k) => k.startsWith("image/")) ? "image" : "display")).join(", ");
  if (collapsed) return <div className="nb-outputs nb-collapsed" onClick={onToggle} title="Click to expand outputs">▸ {outputs.length} output{outputs.length > 1 ? "s" : ""} hidden ({summary})</div>;
  return (
    <div className={`nb-outputs ${long ? "nb-long" : ""}`}>
      <button className="nb-collapse" onClick={onToggle} title="Collapse outputs" aria-label="Collapse outputs">▾</button>
      {long && <div className="nb-long-note" onClick={() => setExpandedLong(true)}>{lines} lines · click to show all</div>}
      {outputs.map((o, i) => {
        if (o.output_type === "stream") return <pre key={i} className={`c-stream ${o.name}`} dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(streamDisplay(o.text)) }} />;
        if (o.output_type === "error") return <pre key={i} className="c-error" dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(o.traceback.join("\n") || `${o.ename}: ${o.evalue}`) }} />;
        return <div key={i} className={o.output_type === "execute_result" ? "c-result" : "c-display"}><Output data={o.data} /></div>;
      })}
    </div>
  );
}

const LINE_H = 19;
function CodeEditor({ uri, value, theme, onChange, onMount, focused }: { uri: string; value: string; theme: string; onChange: (v: string) => void; onMount: (e: monaco.editor.IStandaloneCodeEditor) => void; focused: boolean }) {
  const [h, setH] = useState(Math.max(2, value.split("\n").length) * LINE_H + 12);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bpLines = useStore((s) => s.debug.breakpoints[uri]);
  const debug = useStore((s) => s.debug);
  const bpDec = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const curDec = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    bpDec.current ??= e.createDecorationsCollection();
    bpDec.current.set((bpLines ?? []).map((b: Breakpoint) => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: b.logMessage ? "bp-glyph log" : b.condition || b.hitCondition ? "bp-glyph cond" : "bp-glyph", glyphMarginHoverMessage: { value: bpTitle(b) } } })));
  }, [bpLines, h]);
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    curDec.current ??= e.createDecorationsCollection();
    const f = debug.frames.find((x) => x.id === debug.frameId) ?? debug.frames[0];
    const m = debug.stopped && f ? editorPathFor(f.path) : null;
    if (m && m.uri === uri) curDec.current.set([{ range: new monaco.Range(m.line(f!.line), 1, m.line(f!.line), 1), options: { isWholeLine: true, className: "debug-line", glyphMarginClassName: "debug-arrow" } }]);
    else curDec.current.set([]);
  }, [debug.stopped, debug.frameId, debug.frames, h]);
  const mount: OnMount = (editor, m) => {
    ed.current = editor;
    const resize = () => setH(Math.max(2 * LINE_H, editor.getContentHeight()) + 12);
    editor.onDidContentSizeChange(resize);
    resize();
    editor.onDidChangeModelContent((ev) => {
      const ranges = ev.isFlush ? null : bpDec.current?.getRanges();
      if (ranges) syncBreakpointLines(uri, ranges.map((r) => r.startLineNumber));
    });
    editor.onMouseDown((ev) => {
      if (ev.target.type !== m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !ev.target.position) return;
      if (ev.event.rightButton || ev.event.altKey) setStore({ bpEdit: { uri, line: ev.target.position.lineNumber } });
      else toggleBreakpoint(uri, ev.target.position.lineNumber);
    });
    onMount(editor);
    if (focused) editor.focus();
  };
  return (
    <div style={{ height: h }}>
      <MonacoEditor path={uri} language="python" theme={theme} value={value} onChange={(v) => onChange(v ?? "")} onMount={mount}
        options={{ fontSize: 13, minimap: { enabled: false }, lineNumbers: "off", glyphMargin: true, folding: false, scrollBeyondLastLine: false, scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false }, overviewRulerLanes: 0, renderLineHighlight: "none", automaticLayout: true, lineDecorationsWidth: 8, lineNumbersMinChars: 0, tabSize: 4, quickSuggestions: { other: true, comments: false, strings: false }, wordWrap: "on" }} />
    </div>
  );
}

/** Markdown cell in edit mode: Monaco on the left, live preview on the right. */
function MarkdownEditor({ value, theme, onChange, onDone, onMount, render }: { value: string; theme: string; onChange: (v: string) => void; onDone: () => void; onMount: (e: monaco.editor.IStandaloneCodeEditor) => void; render: (src: string) => { __html: string } }) {
  const [h, setH] = useState(Math.max(3, value.split("\n").length) * LINE_H + 12);
  const [split, setSplit] = useState<boolean>(() => localStorage.getItem("pide.nb.mdsplit") !== "0");
  const mount: OnMount = (editor, m) => {
    const resize = () => setH(Math.max(3 * LINE_H, editor.getContentHeight()) + 12);
    editor.onDidContentSizeChange(resize);
    resize();
    editor.addAction({ id: "pide.nb.mdDoneShiftEnter", label: "Finish Markdown Edit", keybindings: [m.KeyMod.Shift | m.KeyCode.Enter], run: () => onDone() });
    editor.addAction({ id: "pide.nb.mdDoneEscape", label: "Finish Markdown Edit (Esc)", keybindings: [m.KeyCode.Escape], precondition: "!suggestWidgetVisible && !findWidgetVisible", run: () => onDone() });
    onMount(editor);
    editor.focus();
  };
  return (
    <div className={`nb-md-split ${split ? "" : "single"}`}>
      <div className="nb-md-pane" style={{ height: h }}>
        <MonacoEditor language="markdown" theme={theme} value={value} onChange={(v) => onChange(v ?? "")} onMount={mount}
          options={{ fontSize: 13, minimap: { enabled: false }, lineNumbers: "off", glyphMargin: false, folding: false, scrollBeyondLastLine: false, scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false }, overviewRulerLanes: 0, renderLineHighlight: "none", automaticLayout: true, lineDecorationsWidth: 8, lineNumbersMinChars: 0, wordWrap: "on", quickSuggestions: false }} />
      </div>
      {split && <div className="nb-md nb-md-preview" dangerouslySetInnerHTML={render(value || "*(empty)*")} />}
      <div className="nb-md-tools">
        <button title={split ? "Hide preview" : "Show preview"} onClick={() => { setSplit(!split); localStorage.setItem("pide.nb.mdsplit", split ? "0" : "1"); }}>{split ? "◧" : "▭"}</button>
        <button title="Done (Shift+Enter / Esc)" aria-label="Done (Shift+Enter / Esc)" onClick={onDone}>✓</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panel --

export default function NotebookPanel(props: IDockviewPanelProps<{ path: string | null }>) {
  const [path, setPath] = useState<string | null>(props.params.path);
  const pathRef = useRef<string | null>(props.params.path);
  pathRef.current = path;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const editVer = useRef(0); // bumped on every user edit; a save only clears dirty if it did not move
  const savedText = useRef<string | null>(null);
  const saving = useRef(false);
  const checking = useRef(false);
  const [sel, setSel] = useState<string | null>(null);
  const theme = useStore((s) => s.theme);
  const kernel = useStore((s) => s.kernel);
  const editors = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>());
  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;
  // Stable notebook URI for the LSP; cells get vscode-notebook-cell:<path>#<id> like VS Code.
  const nbUriRef = useRef<string>(path ? monaco.Uri.file(path).toString() : `untitled:${/^nb:\/Untitled-/.test(props.api.id) ? props.api.id.slice(4) : `Untitled-${Date.now()}.ipynb`}`);
  const nbUri = nbUriRef.current;
  const cellUri = (id: string) => `vscode-notebook-cell:${nbUri.replace(/^file:\/\//, "").replace(/^untitled:/, "/")}#${id}`;

  // LSP: open once loaded, re-sync structure when cells change, close on unmount.
  const codeCells = (n: Notebook) => n.cells.filter((c) => c.cell_type === "code").map((c) => ({ uri: cellUri(c.id), text: c.source }));
  useEffect(() => { if (nb) openNotebookDoc(nbUri, codeCells(nb)); return () => closeNotebookDoc(nbUri); }, [nb === null]);
  const structureKey = nb ? nb.cells.map((c) => c.cell_type[0] + c.id).join(",") : "";
  useEffect(() => { if (nb) syncNotebookStructure(nbUri, codeCells(nb)); }, [structureKey]);
  // update_display_data updates every output with that display_id, in any cell. Registrations follow
  // the outputs: they change (or are removed on unmount) whenever the set of ids does.
  const displayIds = (nb?.cells ?? []).flatMap((c) => (c.outputs ?? []).flatMap((o) => (o.output_type === "display_data" && (o.metadata as any)?.display_id ? [String((o.metadata as any).display_id)] : []))).join("\n");
  useEffect(() => {
    const offs = [...new Set(displayIds ? displayIds.split("\n") : [])].map((id) => registerDisplay(id, (data) => {
      editVer.current++; setDirty(true);
      setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.outputs?.length ? { ...c, outputs: applyOutput(c.outputs, { kind: "display", data, displayId: id, update: true }) } : c)) } : n));
    }));
    return () => offs.forEach((off) => off());
  }, [displayIds]);

  // Debugger / go-to: reveal a cell line when asked.
  useEffect(() => {
    const d = props.api.onDidParametersChange((p: any) => {
      const r = p?.reveal;
      if (!r?.cellId) return;
      setSel(r.cellId);
      const e = editors.current.get(r.cellId);
      if (e) { e.revealLineInCenter(r.line); e.setPosition({ lineNumber: r.line, column: 1 }); }
      document.getElementById(`cell-${r.cellId}`)?.scrollIntoView({ block: "center" });
    });
    return () => d.dispose();
  }, []);

  useEffect(() => {
    if (path) readText(path).then((t) => { try { setNb(parseNotebook(t)); savedText.current = t; } catch (e) { setLoadError(`not a valid notebook: ${e}`); } }).catch((e) => { pushConsole({ kind: "info", text: String(e) }); setLoadError(String(e)); });
    else setNb(parseNotebook(""));
  }, []);
  useEffect(() => { props.api.setTitle((path ? path.split("/").pop()! : "untitled.ipynb") + (dirty ? " *" : "")); }, [path, dirty]);
  useEffect(() => { if (nb && !sel) setSel(nb.cells[0]?.id ?? null); }, [nb]);

  const update = useCallback((fn: (nb: Notebook) => Notebook) => { setNb((n) => (n ? fn(n) : n)); editVer.current++; setDirty(true); }, []);
  const patchCell = useCallback((id: string, p: Partial<Cell>, markDirty = true) => {
    setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, ...p } : c)) } : n));
    if (markDirty) { editVer.current++; setDirty(true); }
  }, []);

  const doSave = async () => {
    const cur = nbRef.current;
    if (!cur) { pushConsole({ kind: "info", text: "Notebook did not load; refusing to overwrite it." }); return; }
    let p = pathRef.current;
    if (!p) {
      p = await savePath("untitled.ipynb", [{ name: "Notebook", extensions: ["ipynb"] }]);
      if (!p) return;
      setPath(p);
      props.api.updateParameters({ path: p }); // the saved layout restores this panel from its params
    }
    const ver = editVer.current;
    const text = serializeNotebook(cur);
    saving.current = true;
    try { await writeText(p, text); } catch (e) { pushConsole({ kind: "info", text: `Save failed: ${e}` }); return; } finally { saving.current = false; }
    savedText.current = text;
    if (editVer.current === ver) setDirty(false);
    pushConsole({ kind: "info", text: `Saved ${p}` });
  };

  /** Compare disk with the last saved text; reload a clean notebook, ask for a dirty one. */
  const checkReload = async () => {
    const p = pathRef.current;
    const cur = nbRef.current;
    if (!p || !cur || savedText.current === null || saving.current || checking.current || cur.cells.some((c) => c.running)) return;
    checking.current = true;
    try {
      const disk = await readText(p);
      if (saving.current || disk === savedText.current) return;
      if (disk === serializeNotebook(cur)) { savedText.current = disk; setDirty(false); return; }
      let next: Notebook;
      try { next = parseNotebook(disk); } catch { return; }
      if (dirtyRef.current) {
        savedText.current = disk; // ask once per external change
        if (!(await confirmAsync(`${p.split("/").pop()} changed on disk. Reload and discard your unsaved edits?`))) return;
      }
      savedText.current = disk;
      setNb(next);
      editVer.current++;
      setDirty(false);
    } finally {
      checking.current = false;
    }
  };
  useEffect(() => { reloaders.set(props.api.id, checkReload); return () => { reloaders.delete(props.api.id); }; });

  const runCell = async (id: string, advance = false) => {
    const cell = nbRef.current?.cells.find((c) => c.id === id);
    if (!cell) return;
    if (cell.cell_type === "markdown") { patchCell(id, { source: cell.editing ? editors.current.get(id)?.getValue() ?? cell.source : cell.source, editing: false }, false); if (advance) selectNext(id); return "ok"; }
    if (cell.cell_type !== "code") { if (advance) selectNext(id); return "ok"; }
    // Already running (or queued): a second run would interleave both runs' outputs in the cell.
    if (cell.running) { if (advance) selectNext(id, true); return "ok"; }
    const code = editors.current.get(id)?.getValue() ?? cell.source;
    patchCell(id, { source: code, outputs: [], running: true, execution_count: null });
    if (advance) selectNext(id, true);
    try {
      const reply = await execute(code, { echo: false, history: false, sink: (it) => {
        // Outputs are part of the file: one that arrives after a save makes it dirty again.
        if (it.kind === "count") patchCell(id, { execution_count: it.count, running: false }, it.count != null);
        else { editVer.current++; setDirty(true); setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, outputs: applyOutput(c.outputs ?? [], it) } : c)) } : n)); }
      } });
      return (reply?.status ?? "ok") as string;
    } catch (e) {
      pushConsole({ kind: "info", text: `Cell execution failed: ${e}` });
      return "error";
    } finally {
      patchCell(id, { running: false }, false);
    }
  };
  const debugThisCell = async (id: string) => {
    const cell = nbRef.current?.cells.find((c) => c.id === id);
    if (!cell || cell.cell_type !== "code") return;
    const code = editors.current.get(id)?.getValue() ?? cell.source;
    patchCell(id, { source: code, outputs: [], running: true, execution_count: null });
    try {
      await debugCell(code, cellUri(id), 1, (it) => {
        // Outputs are part of the file: one that arrives after a save makes it dirty again.
        if (it.kind === "count") patchCell(id, { execution_count: it.count, running: false }, it.count != null);
        else { editVer.current++; setDirty(true); setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, outputs: applyOutput(c.outputs ?? [], it) } : c)) } : n)); }
      });
    } finally {
      patchCell(id, { running: false }, false);
    }
  };
  const formatCellById = async (id: string) => {
    const cell = nbRef.current?.cells.find((c) => c.id === id);
    if (!cell || cell.cell_type !== "code") return false;
    const editor = editors.current.get(id);
    const text = editor?.getValue() ?? cell.source;
    const out = await formatDocument(cellUri(id), text);
    if (out === null || out === text) return false;
    // Keep the cell's trailing newline policy consistent (ruff emits one).
    const next = out.replace(/\n$/, "");
    if (editor) { const m = editor.getModel()!; editor.executeEdits("ruff", [{ range: m.getFullModelRange(), text: next }]); editor.pushUndoStop(); }
    patchCell(id, { source: next });
    return true;
  };
  const formatAll = async () => {
    let n = 0;
    for (const c of nbRef.current?.cells ?? []) if (await formatCellById(c.id)) n++;
    pushConsole({ kind: "info", text: n ? `ruff: formatted ${n} cell${n > 1 ? "s" : ""}` : "ruff: nothing to change" });
  };
  const toggleAllOutputs = () => { const anyOpen = (nbRef.current?.cells ?? []).some((c) => c.cell_type === "code" && (c.outputs?.length ?? 0) > 0 && !c.collapsed); update((n) => ({ ...n, cells: n.cells.map((c) => (c.cell_type === "code" ? { ...c, collapsed: anyOpen } : c)) })); };

  const runAll = async () => { for (const c of nbRef.current?.cells ?? []) if ((await runCell(c.id)) !== "ok") break; };
  const runAbove = async (id: string) => { for (const c of nbRef.current?.cells ?? []) { if (c.id === id) break; if ((await runCell(c.id)) !== "ok") break; } };

  const selectNext = (id: string, createIfLast = false) => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === id);
    if (i < cells.length - 1) setSel(cells[i + 1].id);
    else if (createIfLast) addCell("code", id, "below");
  };
  const addCell = (type: Cell["cell_type"], relTo: string | null, where: "above" | "below") => {
    const c: Cell = { id: uid(), cell_type: type, source: "", metadata: {}, execution_count: null, outputs: [], editing: type === "markdown" };
    update((n) => {
      const i = relTo ? n.cells.findIndex((x) => x.id === relTo) : n.cells.length - 1;
      const at = where === "above" ? i : i + 1;
      return { ...n, cells: [...n.cells.slice(0, at), c, ...n.cells.slice(at)] };
    });
    setSel(c.id);
  };
  const deleteCell = (id: string) => update((n) => {
    const i = n.cells.findIndex((c) => c.id === id);
    const cells = n.cells.filter((c) => c.id !== id);
    if (!cells.length) cells.push({ id: uid(), cell_type: "code", source: "", metadata: {}, execution_count: null, outputs: [] });
    setSel(cells[Math.min(i, cells.length - 1)].id);
    return { ...n, cells };
  });
  const moveCell = (id: string, dir: -1 | 1) => update((n) => {
    const i = n.cells.findIndex((c) => c.id === id);
    const j = i + dir;
    if (j < 0 || j >= n.cells.length) return n;
    const cells = [...n.cells];
    [cells[i], cells[j]] = [cells[j], cells[i]];
    return { ...n, cells };
  });
  const setType = (id: string, t: Cell["cell_type"]) => patchCell(id, { cell_type: t, outputs: [], execution_count: null, editing: t === "markdown" });
  const clearAll = () => update((n) => ({ ...n, cells: n.cells.map((c) => ({ ...c, outputs: [], execution_count: null })) }));

  const onEditorMount = (id: string) => (editor: monaco.editor.IStandaloneCodeEditor) => {
    editors.current.set(id, editor);
    editor.onDidDispose(() => { if (editors.current.get(id) === editor) editors.current.delete(id); });
    const lint = () => { const model = editor.getModel(); if (model) scheduleLint(monaco, model, "cell.py"); };
    lint();
    editor.onDidChangeModelContent(() => { queueDocumentChange(cellUri(id), () => editor.getValue(), (t) => changeNotebookCell(nbUri, cellUri(id), t)); lint(); });
    editor.onDidFocusEditorText(() => setSel(id));
    const act = (aid: string, label: string, keybindings: number[], run: () => unknown) => editor.addAction({ id: aid, label, keybindings, run: () => { run(); } });
    act("pide.nb.runAdvance", "Run Cell and Advance", [monaco.KeyMod.Shift | monaco.KeyCode.Enter], () => runCell(id, true));
    act("pide.nb.run", "Run Cell", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], () => runCell(id, false));
    act("pide.nb.runInsert", "Run Cell and Insert Below", [monaco.KeyMod.Alt | monaco.KeyCode.Enter], () => { runCell(id, false); addCell("code", id, "below"); });
    act("pide.nb.save", "Save Notebook", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], () => doSave());
    act("pide.nb.formatCell", "Format Cell", [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], () => formatCellById(id));
    act("pide.nb.toggleOutputs", "Toggle Cell Outputs", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO], () => { const c = nbRef.current?.cells.find((x) => x.id === id); if (c) patchCell(id, { collapsed: !c.collapsed }); });
  };

  const md = useMemo(() => (src: string) => safeHtml(marked.parse(src, { async: false }) as string), []);
  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

  useEffect(() => { setDirtyPanel(props.api.id, path ? path.split("/").pop()! : "untitled.ipynb", dirty); }, [dirty, path]);
  useEffect(() => () => setDirtyPanel(props.api.id, "", false), []);
  if (loadError) return <div className="vv-error">Could not open {path}: {loadError}</div>;
  if (!nb) return <div className="vv-loading">Loading…</div>;
  return (
    <div className="notebook" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); doSave(); } }}>
      <div className="panel-toolbar nb-toolbar">
        <button onClick={() => addCell("code", sel, "below")} title="Insert code cell below (Alt+Enter runs and inserts)">＋ Code</button>
        <button onClick={() => addCell("markdown", sel, "below")}>＋ Markdown</button>
        <span className="sep" />
        <button onClick={() => sel && runCell(sel, true)} title="Shift+Enter">▶ Run</button>
        <button onClick={runAll}>▶▶ Run All</button>
        <button onClick={() => sel && runAbove(sel)}>Run Above</button>
        <button onClick={interrupt} disabled={kernel !== "busy"}>⏹</button>
        <button onClick={() => sel && debugThisCell(sel)} title="Run this cell under the debugger (set breakpoints in the cell gutter)">🐞 Debug</button>
        <span className="sep" />
        <button onClick={() => sel && moveCell(sel, -1)} title="Move up" aria-label="Move up">↑</button>
        <button onClick={() => sel && moveCell(sel, 1)} title="Move down" aria-label="Move down">↓</button>
        <button onClick={() => sel && deleteCell(sel)} title="Delete cell" aria-label="Delete cell">🗑</button>
        <select value={nb.cells.find((c) => c.id === sel)?.cell_type ?? "code"} onChange={(e) => sel && setType(sel, e.target.value as Cell["cell_type"])}>
          <option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option>
        </select>
        <span className="sep" />
        <button onClick={() => sel && formatCellById(sel)} title="ruff format this cell (Shift+Alt+F)">Format</button>
        <button onClick={formatAll} title="ruff format every code cell">Format All</button>
        <span className="sep" />
        <button onClick={toggleAllOutputs} title="Collapse / expand all outputs (Cmd+O toggles the current cell)">⇕ Outputs</button>
        <button onClick={clearAll}>Clear Outputs</button>
        <button onClick={doSave} title="Cmd+S">Save</button>
        <span className="muted nb-count">{nb.cells.length} cells</span>
      </div>
      <div className="nb-cells">
        {nb.cells.map((c) => (
          <div key={c.id} id={`cell-${c.id}`} className={`nb-cell ${c.cell_type} ${sel === c.id ? "selected" : ""} ${c.running ? "running" : ""}`} onClick={() => setSel(c.id)}>
            <div className="nb-gutter">
              {c.cell_type === "code" ? <span className="nb-prompt">{c.running ? "[*]" : `[${c.execution_count ?? " "}]`}</span> : <span className="nb-prompt muted">{c.cell_type === "markdown" ? "md" : "raw"}</span>}
              {c.cell_type === "code" && <button className="nb-run" title="Run cell" aria-label="Run cell" onClick={(e) => { e.stopPropagation(); runCell(c.id); }}>▶</button>}
            </div>
            <div className="nb-body">
              {c.cell_type === "code" ? (
                <CodeEditor uri={cellUri(c.id)} value={c.source} theme={monacoTheme} focused={sel === c.id} onChange={(v) => patchCell(c.id, { source: v })} onMount={onEditorMount(c.id)} />
              ) : c.cell_type === "markdown" && (c.editing || !c.source.trim()) ? (
                <MarkdownEditor value={c.source} theme={monacoTheme} render={md}
                  onChange={(v) => patchCell(c.id, { source: v })}
                  onMount={(e) => { editors.current.set(c.id, e); e.onDidDispose(() => { if (editors.current.get(c.id) === e) editors.current.delete(c.id); }); }}
                  onDone={() => { patchCell(c.id, { editing: false }, false); if (nbRef.current?.cells.find((x) => x.id === c.id)?.source.trim()) selectNext(c.id, true); }} />
              ) : c.editing || !c.source.trim() ? (
                <textarea className="nb-md-edit" value={c.source} autoFocus placeholder="Raw cell" rows={Math.max(2, c.source.split("\n").length)}
                  onChange={(e) => patchCell(c.id, { source: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); patchCell(c.id, { editing: false }, false); selectNext(c.id, true); } }} />
              ) : (
                <div className={c.cell_type === "markdown" ? "nb-md" : "nb-raw"} onDoubleClick={() => patchCell(c.id, { editing: true }, false)} dangerouslySetInnerHTML={c.cell_type === "markdown" ? md(c.source) : safeHtml(`<pre>${c.source.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`)} />
              )}
              {c.cell_type === "code" && <CellOutputs outputs={c.outputs ?? []} collapsed={!!c.collapsed} onToggle={() => patchCell(c.id, { collapsed: !c.collapsed })} />}
            </div>
          </div>
        ))}
        <div className="nb-add" onClick={() => addCell("code", nb.cells[nb.cells.length - 1]?.id ?? null, "below")}>＋ add cell</div>
      </div>
    </div>
  );
}
