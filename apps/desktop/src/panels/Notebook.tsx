import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import { execute, interrupt, type OutputItem } from "../kernel";
import { pushConsole, useStore } from "../store";
import { Output, ansi } from "./Console";

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
  /** UI only */
  editing?: boolean;
  running?: boolean;
}

interface Notebook { cells: Cell[]; metadata: Mime; nbformat: number; nbformat_minor: number }

const uid = () => Math.random().toString(36).slice(2, 10);
const joinSrc = (s: unknown) => (Array.isArray(s) ? s.join("") : String(s ?? ""));
const splitSrc = (s: string) => { const lines = s.split("\n"); return lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l)).filter((l, i, a) => !(i === a.length - 1 && l === "")); };

function parseNotebook(text: string): Notebook {
  const nb = text.trim() ? JSON.parse(text) : {};
  const cells: Cell[] = (nb.cells ?? []).map((c: any) => ({
    id: c.id ?? uid(),
    cell_type: c.cell_type ?? "code",
    source: joinSrc(c.source),
    metadata: c.metadata ?? {},
    execution_count: c.execution_count ?? null,
    outputs: (c.outputs ?? []).map((o: any) => (o.output_type === "stream" ? { ...o, text: joinSrc(o.text) } : o.output_type === "error" ? o : { ...o, data: Object.fromEntries(Object.entries(o.data ?? {}).map(([k, v]) => [k, k.startsWith("image/") || k === "application/json" ? (Array.isArray(v) ? v.join("") : v) : joinSrc(v)])) })),
  }));
  if (!cells.length) cells.push({ id: uid(), cell_type: "code", source: "", metadata: {}, execution_count: null, outputs: [] });
  return { cells, metadata: nb.metadata ?? { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, nbformat: nb.nbformat ?? 4, nbformat_minor: nb.nbformat_minor ?? 5 };
}

function serializeNotebook(nb: Notebook): string {
  const cells = nb.cells.map((c) => {
    const base: any = { cell_type: c.cell_type, id: c.id, metadata: c.metadata, source: splitSrc(c.source) };
    if (c.cell_type === "code") {
      base.execution_count = c.execution_count ?? null;
      base.outputs = (c.outputs ?? []).map((o) => {
        if (o.output_type === "stream") return { output_type: "stream", name: o.name, text: splitSrc(o.text) };
        if (o.output_type === "error") return o;
        const data = Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, typeof v === "string" && !k.startsWith("image/") ? splitSrc(v) : v]));
        return o.output_type === "execute_result" ? { output_type: "execute_result", data, metadata: o.metadata ?? {}, execution_count: o.execution_count ?? null } : { output_type: "display_data", data, metadata: o.metadata ?? {} };
      });
    }
    return base;
  });
  return JSON.stringify({ cells, metadata: nb.metadata, nbformat: nb.nbformat, nbformat_minor: nb.nbformat_minor }, null, 1) + "\n";
}

/** Apply a kernel output item to a cell's output list (nbformat shape). */
function applyOutput(outputs: NbOutput[], it: OutputItem): NbOutput[] {
  switch (it.kind) {
    case "clear": return [];
    case "stream": {
      const last = outputs[outputs.length - 1];
      if (last && last.output_type === "stream" && last.name === it.name) return [...outputs.slice(0, -1), { ...last, text: last.text + it.text }];
      return [...outputs, { output_type: "stream", name: it.name, text: it.text }];
    }
    case "result": return [...outputs, { output_type: "execute_result", data: it.data, metadata: {}, execution_count: it.count }];
    case "display": return [...outputs, { output_type: "display_data", data: it.data, metadata: {} }];
    case "error": return [...outputs, { output_type: "error", ename: it.ename, evalue: it.evalue, traceback: it.traceback }];
    default: return outputs;
  }
}

// --------------------------------------------------------------- cells --

function CellOutputs({ outputs }: { outputs: NbOutput[] }) {
  if (!outputs.length) return null;
  return (
    <div className="nb-outputs">
      {outputs.map((o, i) => {
        if (o.output_type === "stream") return <pre key={i} className={`c-stream ${o.name}`} dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(o.text) }} />;
        if (o.output_type === "error") return <pre key={i} className="c-error" dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(o.traceback.join("\n") || `${o.ename}: ${o.evalue}`) }} />;
        return <div key={i} className={o.output_type === "execute_result" ? "c-result" : "c-display"}><Output data={o.data} /></div>;
      })}
    </div>
  );
}

const LINE_H = 19;
function CodeEditor({ value, theme, onChange, onMount, focused }: { value: string; theme: string; onChange: (v: string) => void; onMount: (e: monaco.editor.IStandaloneCodeEditor) => void; focused: boolean }) {
  const [h, setH] = useState(Math.max(2, value.split("\n").length) * LINE_H + 12);
  const mount: OnMount = (editor) => {
    const resize = () => setH(Math.max(2 * LINE_H, editor.getContentHeight()) + 12);
    editor.onDidContentSizeChange(resize);
    resize();
    onMount(editor);
    if (focused) editor.focus();
  };
  return (
    <div style={{ height: h }}>
      <MonacoEditor language="python" theme={theme} value={value} onChange={(v) => onChange(v ?? "")} onMount={mount}
        options={{ fontSize: 13, minimap: { enabled: false }, lineNumbers: "off", glyphMargin: false, folding: false, scrollBeyondLastLine: false, scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false }, overviewRulerLanes: 0, renderLineHighlight: "none", automaticLayout: true, lineDecorationsWidth: 8, lineNumbersMinChars: 0, tabSize: 4, quickSuggestions: { other: true, comments: false, strings: false }, wordWrap: "on" }} />
    </div>
  );
}

// ---------------------------------------------------------------- panel --

export default function NotebookPanel(props: IDockviewPanelProps<{ path: string | null }>) {
  const [path, setPath] = useState<string | null>(props.params.path);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const theme = useStore((s) => s.theme);
  const kernel = useStore((s) => s.kernel);
  const editors = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>());
  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;

  useEffect(() => {
    if (path) invoke<string>("read_text_file", { path }).then((t) => setNb(parseNotebook(t))).catch((e) => { pushConsole({ kind: "info", text: String(e) }); setNb(parseNotebook("")); });
    else setNb(parseNotebook(""));
  }, []);
  useEffect(() => { props.api.setTitle((path ? path.split("/").pop()! : "untitled.ipynb") + (dirty ? " *" : "")); }, [path, dirty]);
  useEffect(() => { if (nb && !sel) setSel(nb.cells[0]?.id ?? null); }, [nb]);

  const update = useCallback((fn: (nb: Notebook) => Notebook) => { setNb((n) => (n ? fn(n) : n)); setDirty(true); }, []);
  const patchCell = useCallback((id: string, p: Partial<Cell>, markDirty = true) => {
    setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, ...p } : c)) } : n));
    if (markDirty) setDirty(true);
  }, []);

  const doSave = async () => {
    const cur = nbRef.current;
    if (!cur) return;
    let p = path;
    if (!p) {
      p = await save({ defaultPath: "untitled.ipynb", filters: [{ name: "Notebook", extensions: ["ipynb"] }] });
      if (!p) return;
      setPath(p);
    }
    await invoke("write_text_file", { path: p, content: serializeNotebook(cur) });
    setDirty(false);
    pushConsole({ kind: "info", text: `Saved ${p}` });
  };

  const runCell = async (id: string, advance = false) => {
    const cell = nbRef.current?.cells.find((c) => c.id === id);
    if (!cell) return;
    if (cell.cell_type === "markdown") { patchCell(id, { editing: false }, false); if (advance) selectNext(id); return; }
    const code = editors.current.get(id)?.getValue() ?? cell.source;
    patchCell(id, { source: code, outputs: [], running: true, execution_count: null });
    if (advance) selectNext(id, true);
    try {
      await execute(code, { echo: false, history: false, sink: (it) => {
        if (it.kind === "count") patchCell(id, { execution_count: it.count, running: false }, false);
        else setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === id ? { ...c, outputs: applyOutput(c.outputs ?? [], it) } : c)) } : n));
      } });
    } finally {
      patchCell(id, { running: false }, false);
    }
  };
  const runAll = async () => { for (const c of nbRef.current?.cells ?? []) await runCell(c.id); };
  const runAbove = async (id: string) => { for (const c of nbRef.current?.cells ?? []) { if (c.id === id) break; await runCell(c.id); } };

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
    editor.onDidFocusEditorText(() => setSel(id));
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runCell(id, true));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCell(id, false));
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => { runCell(id, false); addCell("code", id, "below"); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => doSave());
  };

  const md = useMemo(() => (src: string) => ({ __html: marked.parse(src, { async: false }) as string }), []);
  const monacoTheme = theme === "dark" ? "vs-dark" : "vs";

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
        <span className="sep" />
        <button onClick={() => sel && moveCell(sel, -1)} title="Move up">↑</button>
        <button onClick={() => sel && moveCell(sel, 1)} title="Move down">↓</button>
        <button onClick={() => sel && deleteCell(sel)} title="Delete cell">🗑</button>
        <select value={nb.cells.find((c) => c.id === sel)?.cell_type ?? "code"} onChange={(e) => sel && setType(sel, e.target.value as Cell["cell_type"])}>
          <option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option>
        </select>
        <span className="sep" />
        <button onClick={clearAll}>Clear Outputs</button>
        <button onClick={doSave} title="Cmd+S">Save</button>
        <span className="muted nb-count">{nb.cells.length} cells</span>
      </div>
      <div className="nb-cells">
        {nb.cells.map((c) => (
          <div key={c.id} className={`nb-cell ${c.cell_type} ${sel === c.id ? "selected" : ""} ${c.running ? "running" : ""}`} onClick={() => setSel(c.id)}>
            <div className="nb-gutter">
              {c.cell_type === "code" ? <span className="nb-prompt">{c.running ? "[*]" : `[${c.execution_count ?? " "}]`}</span> : <span className="nb-prompt muted">{c.cell_type === "markdown" ? "md" : "raw"}</span>}
              {c.cell_type === "code" && <button className="nb-run" title="Run cell" onClick={(e) => { e.stopPropagation(); runCell(c.id); }}>▶</button>}
            </div>
            <div className="nb-body">
              {c.cell_type === "code" ? (
                <CodeEditor value={c.source} theme={monacoTheme} focused={sel === c.id} onChange={(v) => patchCell(c.id, { source: v })} onMount={onEditorMount(c.id)} />
              ) : c.editing || !c.source.trim() ? (
                <textarea className="nb-md-edit" value={c.source} autoFocus placeholder={c.cell_type === "markdown" ? "Markdown… (Shift+Enter to render)" : "Raw cell"} rows={Math.max(2, c.source.split("\n").length)}
                  onChange={(e) => patchCell(c.id, { source: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); patchCell(c.id, { editing: false }, false); selectNext(c.id, true); } }} />
              ) : (
                <div className={c.cell_type === "markdown" ? "nb-md" : "nb-raw"} onDoubleClick={() => patchCell(c.id, { editing: true }, false)} dangerouslySetInnerHTML={c.cell_type === "markdown" ? md(c.source) : { __html: `<pre>${c.source.replace(/</g, "&lt;")}</pre>` }} />
              )}
              {c.cell_type === "code" && <CellOutputs outputs={c.outputs ?? []} />}
            </div>
          </div>
        ))}
        <div className="nb-add" onClick={() => addCell("code", nb.cells[nb.cells.length - 1]?.id ?? null, "below")}>＋ add cell</div>
      </div>
    </div>
  );
}
