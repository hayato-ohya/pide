import { useEffect, useRef, useState } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { IDockviewPanelProps } from "dockview";
import { parseConflicts, resolveBlockLines, type ConflictBlock, type Side } from "../conflicts";
import { refreshGit } from "../git";
import { invoke } from "@tauri-apps/api/core";
import { isRemote, readText, savePath, writeText } from "../fs";
import { scheduleLint } from "../tools";
import { execute } from "../kernel";
import { get, pushConsole, setDirtyPanel, useStore } from "../store";
import { cont, debugCell, debugFile, editorPathFor, setBreakpoint, syncBreakpointLines, toggleBreakpoint, type Breakpoint } from "../debug";
import { set as setStore } from "../store";
import { confirmAsync } from "../dialogs";
import { reloaders } from "../reload";
import { changeDocument, closeDocument, initLsp, openDocument, queueDocumentChange, saveDocument } from "../lsp";

// Use the bundled monaco (no CDN) so the app works offline.
loader.config({ monaco });
initLsp(monaco);

type Editor = Parameters<OnMount>[0];

/** Registry so the toolstrip can act on the active editor. */
export const editors = new Map<string, { run: () => void; runCell: () => void; save: () => Promise<boolean>; format: () => void; debug: () => void; debugCell: () => void; path: string | null }>();
export let activeEditorId: string | null = null;
let untitledCounter = 0;
export function bpTitle(b: Breakpoint) {
  const parts = [`Breakpoint line ${b.line}`];
  if (b.condition) parts.push(`when ${b.condition}`);
  if (b.hitCondition) parts.push(`hit ${b.hitCondition}`);
  if (b.logMessage) parts.push(`log: ${b.logMessage}`);
  return parts.join(" · ") + "  (right-click to edit)";
}

/** Split code into `# %%` cells and return the one containing `line` (1-based). */
function cellAt(code: string, line: number): { code: string; start: number } {
  const lines = code.split("\n");
  const starts = [0];
  lines.forEach((l, i) => { if (/^\s*#\s*%%/.test(l) && i > 0) starts.push(i); });
  let s = 0;
  for (const st of starts) if (st <= line - 1) s = st;
  const next = starts.find((st) => st > s) ?? lines.length;
  return { code: lines.slice(s, next).join("\n"), start: s + 1 };
}

export default function EditorPanel(props: IDockviewPanelProps<{ path: string | null; reveal?: number | null }>) {
  const [path, setPath] = useState<string | null>(props.params.path);
  const [content, setContent] = useState<string | null>(props.params.path ? null : "");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictBlock[]>([]);
  const ed = useRef<Editor | null>(null);
  const savedText = useRef<string | null>(null); // last text known to be on disk
  const saving = useRef(false);
  const checking = useRef(false);
  const id = props.api.id;
  // Stable URI for the LSP: real files use file://, new buffers use untitled:.
  const uriRef = useRef<string>(path ? monaco.Uri.file(path).toString() : `untitled:Untitled-${++untitledCounter}.py`);
  const uri = uriRef.current;

  useEffect(() => {
    if (path) readText(path).then((t) => { savedText.current = t; setContent(t); }).catch((e) => { pushConsole({ kind: "info", text: String(e) }); setLoadError(String(e)); });
  }, [loadError === "retry"]);

  useEffect(() => {
    props.api.setTitle((path ? path.split("/").pop()! : "untitled.py") + (dirty ? " *" : ""));
  }, [path, dirty]);
  useEffect(() => { props.api.updateParameters({ ...props.params, uri }); }, []);

  // Reveal a line when asked (go-to-definition / "open at line").
  useEffect(() => {
    const d = props.api.onDidParametersChange?.((p: any) => reveal(p?.reveal));
    return () => d?.dispose();
  });
  const reveal = (line?: number | null) => {
    if (!line || !ed.current) return;
    ed.current.revealLineInCenter(line);
    ed.current.setPosition({ lineNumber: line, column: 1 });
    ed.current.focus();
  };

  /** Resolves false when nothing was written (cancelled dialog, write error): callers that
   * go on to use the file on disk (Run, Debug, Mark resolved) must stop then. */
  const doSave = async (): Promise<boolean> => {
    if (content === null) { pushConsole({ kind: "info", text: "File did not load; refusing to overwrite it." }); return false; }
    let p = path;
    const wasUntitled = !p;
    if (!p) {
      p = await savePath("untitled.py", [{ name: "Python", extensions: ["py"] }]);
      if (!p) return false;
    }
    const text = ed.current?.getValue() ?? content ?? "";
    const ver = ed.current?.getModel()?.getAlternativeVersionId();
    // Changed on disk since it was loaded / last saved (a `git checkout` in the terminal, a
    // script that rewrote it) while the window kept focus, so checkReload never ran: ask
    // before overwriting.  Local files only: a remote read waits behind a running cell.
    if (!wasUntitled && savedText.current !== null && !isRemote()) {
      const disk = await readText(p).catch(() => null); // deleted / unreadable: just write
      if (disk !== null && disk !== savedText.current && disk !== text) {
        if (!(await confirmAsync(`${p.split("/").pop()} changed on disk since it was opened. Overwrite it with your version?`))) return false;
        savedText.current = disk; // asked once for this change
      }
    }
    saving.current = true;
    try {
      await writeText(p, text);
    } catch (e) {
      pushConsole({ kind: "info", text: `Save failed: ${e}` });
      return false;
    } finally {
      saving.current = false;
    }
    savedText.current = text;
    // Keystrokes typed while the save was in flight must stay dirty.
    if (ed.current?.getModel()?.getAlternativeVersionId() === ver) setDirty(false);
    pushConsole({ kind: "info", text: `Saved ${p}` });
    if (wasUntitled) {
      // Re-open under the real path so LSP, breakpoints and "open file" all key on it.
      const { openFile } = await import("../layout");
      const bps = get().debug.breakpoints[uri];
      for (const b of bps ?? []) toggleBreakpoint(uri, b.line); // moved to the file below, not copied
      closeDocument(uri);
      props.api.close();
      openFile(p, ed.current?.getPosition()?.lineNumber);
      if (bps?.length) setTimeout(() => { for (const b of bps) setBreakpoint(monaco.Uri.file(p!).toString(), b.line, b); }, 300);
      return true;
    }
    saveDocument(uri);
    return true;
  };

  /** MATLAB-style Run: save, then execute the file by name so tracebacks and breakpoints point at it. */
  const run = async () => {
    const text = ed.current?.getValue() ?? "";
    if (path) {
      if (dirty && !(await doSave())) return; // never run the stale file on disk
      pushConsole({ kind: "info", text: `Run ${path.split("/").pop()}` });
      execute(`__import__('pide_kernel').run_file(${JSON.stringify(path)})`, { echo: false });
    } else {
      pushConsole({ kind: "info", text: "Run untitled" });
      execute(text, { echo: false });
    }
  };
  const currentCell = () => {
    const e = ed.current;
    const model = e?.getModel();
    if (!e || !model) return null;
    const sel = e.getSelection();
    if (sel && !sel.isEmpty()) return { code: model.getValueInRange(sel), start: sel.startLineNumber };
    return cellAt(model.getValue(), e.getPosition()?.lineNumber ?? 1);
  };
  const runCell = () => { const c = currentCell(); if (c) execute(c.code); };
  const debugThis = async () => {
    if (!path) { pushConsole({ kind: "info", text: "Save the file before debugging it (or use Debug Cell)." }); return; }
    if (dirty && !(await doSave())) return;
    debugFile(path);
  };
  const debugThisCell = () => { const c = currentCell(); if (c) debugCell(c.code, uri, c.start); };
  const format = () => ed.current?.getAction("editor.action.formatDocument")?.run();

  useEffect(() => {
    editors.set(id, { run, runCell, save: doSave, format, debug: debugThis, debugCell: debugThisCell, path });
    const d = props.api.onDidActiveChange((e) => { if (e.isActive) activeEditorId = id; });
    if (props.api.isActive) activeEditorId = id;
    return () => { editors.delete(id); d.dispose(); };
  });

  /** Compare disk with the last saved text; reload a clean buffer, ask for a dirty one. */
  const checkReload = async () => {
    const e = ed.current; const model = e?.getModel();
    if (!path || !e || !model || savedText.current === null || saving.current || checking.current) return;
    checking.current = true;
    try {
      const disk = await readText(path);
      if (saving.current || disk === savedText.current) return;
      const cur = model.getValue();
      if (disk === cur) { savedText.current = disk; setDirty(false); return; }
      if (dirtyRef.current) {
        savedText.current = disk; // ask once per external change
        if (!(await confirmAsync(`${path.split("/").pop()} changed on disk. Reload and discard your unsaved edits?`))) return;
      }
      savedText.current = disk;
      const pos = e.getPosition();
      e.pushUndoStop();
      e.executeEdits("reload", [{ range: model.getFullModelRange(), text: disk }]);
      e.pushUndoStop();
      if (pos) e.setPosition(model.validatePosition(pos));
      setDirty(false);
    } finally {
      checking.current = false;
    }
  };
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => { reloaders.set(id, checkReload); return () => { reloaders.delete(id); }; });

  useEffect(() => () => closeDocument(uri), []);
  useEffect(() => { setDirtyPanel(id, path ? path.split("/").pop()! : "untitled.py", dirty); }, [dirty, path]);
  useEffect(() => () => setDirtyPanel(id, "", false), []);

  const onMount: OnMount = (editor, m) => {
    ed.current = editor;
    setMounted(true); // the decoration effects below ran before the editor existed
    if (import.meta.env.DEV && (window as any).pide) (window as any).pide.editor = editor;
    editor.addAction({ id: "pide.runCellCtrlEnter", label: "Run Cell", keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], run: () => { editors.get(id)?.runCell(); } });
    editor.addAction({ id: "pide.runOrContinue", label: "Run File / Continue", keybindings: [m.KeyCode.F5], run: () => { if (get().debug.stopped) cont(); else editors.get(id)?.run(); } });
    editor.addAction({ id: "pide.save", label: "Save File", keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS], run: () => { editors.get(id)?.save(); } });
    editor.addAction({ id: "pide.runCellF9", label: "Run Cell (F9)", keybindings: [m.KeyCode.F9], run: () => { editors.get(id)?.runCell(); } });
    editor.addAction({ id: "pide.format", label: "Format File", keybindings: [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF], run: () => { editors.get(id)?.format(); } });
    openDocument(uri, editor.getValue());
    const lint = () => { const model = editor.getModel(); if (model) scheduleLint(m, model, path?.split("/").pop() ?? "untitled.py"); };
    lint();
    editor.onDidChangeModelContent((ev) => {
      setDirty(true);
      const ranges = ev.isFlush ? null : bpDec.current?.getRanges(); // a full setValue collapses decorations; do not sync that
      if (ranges) syncBreakpointLines(uri, ranges.map((r) => r.startLineNumber));
      queueDocumentChange(uri, () => editor.getValue(), (t) => changeDocument(uri, t));
      lint();
    });
    // Highlight `# %%` cell separators like MATLAB sections.
    const dec = editor.createDecorationsCollection();
    const refresh = () => {
      const model = editor.getModel();
      if (!model) return;
      const ds = [];
      for (let i = 1; i <= model.getLineCount(); i++) {
        if (/^\s*#\s*%%/.test(model.getLineContent(i))) ds.push({ range: new m.Range(i, 1, i, 1), options: { isWholeLine: true, className: "cell-sep" } });
      }
      // Merge-conflict blocks: tint ours / theirs and bold the markers.
      const blocks = parseConflicts(model.getValue());
      for (const b of blocks) {
        const oursEnd = (b.base ?? b.mid) - 1;
        if (oursEnd > b.start) ds.push({ range: new m.Range(b.start + 1, 1, oursEnd, 1), options: { isWholeLine: true, className: "conflict-ours" } });
        if (b.end - 1 > b.mid) ds.push({ range: new m.Range(b.mid + 1, 1, b.end - 1, 1), options: { isWholeLine: true, className: "conflict-theirs" } });
        for (const l of [b.start, b.base, b.mid, b.end]) if (l) ds.push({ range: new m.Range(l, 1, l, 1), options: { isWholeLine: true, className: "conflict-marker" } });
      }
      setConflicts((prev) => (prev.length === 0 && blocks.length === 0 ? prev : blocks));
      dec.set(ds);
    };
    editor.onDidChangeModelContent(refresh);
    refresh();
    editor.onMouseDown((ev) => {
      if (ev.target.type !== m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !ev.target.position) return;
      if (ev.event.rightButton || ev.event.altKey) setStore({ bpEdit: { uri, line: ev.target.position.lineNumber } });
      else toggleBreakpoint(uri, ev.target.position.lineNumber);
    });
    reveal(props.params.reveal);
  };

  // Breakpoint glyphs and the debugger's current line.
  const theme = useStore((s) => s.theme);
  const bpLines = useStore((s) => s.debug.breakpoints[uri]);
  const debug = useStore((s) => s.debug);
  const bpDec = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const curDec = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    bpDec.current ??= e.createDecorationsCollection();
    bpDec.current.set((bpLines ?? []).map((b: Breakpoint) => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: b.logMessage ? "bp-glyph log" : b.condition || b.hitCondition ? "bp-glyph cond" : "bp-glyph", glyphMarginHoverMessage: { value: bpTitle(b) } } })));
  }, [bpLines, content, mounted]);
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    curDec.current ??= e.createDecorationsCollection();
    const f = debug.frames.find((x) => x.id === debug.frameId) ?? debug.frames[0];
    const m = debug.stopped && f ? editorPathFor(f.path) : null;
    if (m && m.uri === uri) {
      const line = m.line(f!.line);
      curDec.current.set([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "debug-line", glyphMarginClassName: "debug-arrow" } }]);
      e.revealLineInCenterIfOutsideViewport(line);
    } else curDec.current.set([]);
  }, [debug.stopped, debug.frameId, debug.frames, content, mounted]);

  /** Replace the conflict block containing the cursor (or the first one) with the chosen side. */
  const acceptAt = (side: Side) => {
    const e = ed.current; const model = e?.getModel();
    if (!e || !model) return;
    const line = e.getPosition()?.lineNumber ?? 1;
    const b = conflicts.find((x) => line >= x.start && line <= x.end) ?? conflicts.find((x) => x.start > line) ?? conflicts[0];
    if (!b) return;
    const keep = resolveBlockLines(model.getLinesContent(), b, side);
    // Nothing kept (that side deleted the lines): remove the block with its line break, or an
    // empty line would stay behind.
    const last = model.getLineCount();
    const range = keep.length || (b.start === 1 && b.end === last)
      ? new monaco.Range(b.start, 1, b.end, model.getLineMaxColumn(b.end))
      : b.end < last
        ? new monaco.Range(b.start, 1, b.end + 1, 1)
        : new monaco.Range(b.start - 1, model.getLineMaxColumn(b.start - 1), b.end, model.getLineMaxColumn(b.end));
    e.executeEdits("conflict", [{ range, text: keep.join("\n") }]);
    e.setPosition({ lineNumber: b.start, column: 1 });
    e.focus();
  };
  const nextConflict = () => {
    const e = ed.current; if (!e) return;
    const line = e.getPosition()?.lineNumber ?? 0;
    const b = conflicts.find((x) => x.start > line) ?? conflicts[0];
    if (b) { e.revealLineInCenter(b.start); e.setPosition({ lineNumber: b.start, column: 1 }); e.focus(); }
  };
  const markResolved = async () => {
    if (!path) return;
    if (!(await doSave())) return; // do not stage the old content
    const root = get().git.status?.root;
    if (!root || !path.startsWith(root + "/")) return;
    try {
      await invoke("git_resolve", { cwd: get().cwd, path, side: "workdir", allowMarkers: false });
      pushConsole({ kind: "info", text: `Resolved ${path}` });
      refreshGit();
    } catch (e) { pushConsole({ kind: "info", text: `git: ${e}` }); }
  };
  const gitRoot = useStore((s) => s.git.status?.root);
  const inRepo = !!(path && gitRoot && path.startsWith(gitRoot + "/"));
  const isConflicted = useStore((s) => !!(path && gitRoot && s.git.status?.entries.some((e) => e.area === "conflicted" && `${gitRoot}/${e.path}` === path)));

  if (loadError && loadError !== "retry") return <div className="vv-error">Could not open {path}: {loadError} <button onClick={() => setLoadError("retry")}>Retry</button></div>;
  if (content === null) return <div className="vv-loading">Loading…</div>;
  const showBar = conflicts.length > 0 || isConflicted;
  return (
    <div className={`editor-panel${showBar ? " with-bar" : ""}`}>
      {showBar && (
        <div className="conflict-bar" role="toolbar" aria-label="Merge conflicts">
          <span>{conflicts.length ? `${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}` : "No conflict markers left"}</span>
          {conflicts.length > 0 && <>
            <button onClick={() => acceptAt("ours")} title="Keep the current (HEAD) side of the block at the cursor">Accept ours</button>
            <button onClick={() => acceptAt("theirs")} title="Keep the incoming side of the block at the cursor">Accept theirs</button>
            <button onClick={() => acceptAt("both")} title="Keep both sides">Accept both</button>
            <button onClick={nextConflict}>Next ↓</button>
          </>}
          <span className="spacer" />
          {inRepo && <button onClick={markResolved} title="Save and stage this file as resolved">Mark resolved</button>}
        </div>
      )}
      <section>
      <MonacoEditor
        path={uri}
        language="python"
        theme={theme === "dark" ? "vs-dark" : "vs"}
        defaultValue={content}
        onMount={onMount}
        options={{ fontSize: 13, glyphMargin: true, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, renderLineHighlight: "all", tabSize: 4, quickSuggestions: { other: true, comments: false, strings: false }, suggestOnTriggerCharacters: true, parameterHints: { enabled: true } }}
      />
      </section>
    </div>
  );
}
