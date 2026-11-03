import { useEffect, useRef, useState } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { IDockviewPanelProps } from "dockview";
import { readText, savePath, writeText } from "../fs";
import { scheduleLint } from "../tools";
import { execute } from "../kernel";
import { get, pushConsole, setDirtyPanel, useStore } from "../store";
import { cont, debugCell, debugFile, editorPathFor, setBreakpoint, toggleBreakpoint, type Breakpoint } from "../debug";
import { set as setStore } from "../store";
import { changeDocument, closeDocument, initLsp, openDocument, queueDocumentChange, saveDocument } from "../lsp";

// Use the bundled monaco (no CDN) so the app works offline.
loader.config({ monaco });
initLsp(monaco);

type Editor = Parameters<OnMount>[0];

/** Registry so the toolstrip can act on the active editor. */
export const editors = new Map<string, { run: () => void; runCell: () => void; save: () => Promise<void>; format: () => void; debug: () => void; debugCell: () => void; path: string | null }>();
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
  const [dirty, setDirty] = useState(false);
  const ed = useRef<Editor | null>(null);
  const id = props.api.id;
  // Stable URI for the LSP: real files use file://, new buffers use untitled:.
  const uriRef = useRef<string>(path ? monaco.Uri.file(path).toString() : `untitled:Untitled-${++untitledCounter}.py`);
  const uri = uriRef.current;

  useEffect(() => {
    if (path) readText(path).then(setContent).catch((e) => { pushConsole({ kind: "info", text: String(e) }); setLoadError(String(e)); });
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

  const doSave = async () => {
    if (content === null) { pushConsole({ kind: "info", text: "File did not load; refusing to overwrite it." }); return; }
    let p = path;
    const wasUntitled = !p;
    if (!p) {
      p = await savePath("untitled.py", [{ name: "Python", extensions: ["py"] }]);
      if (!p) return;
    }
    const text = ed.current?.getValue() ?? content ?? "";
    try {
      await writeText(p, text);
    } catch (e) {
      pushConsole({ kind: "info", text: `Save failed: ${e}` });
      return;
    }
    setDirty(false);
    pushConsole({ kind: "info", text: `Saved ${p}` });
    if (wasUntitled) {
      // Re-open under the real path so LSP, breakpoints and "open file" all key on it.
      const { openFile } = await import("../layout");
      const bps = get().debug.breakpoints[uri];
      closeDocument(uri);
      props.api.close();
      openFile(p, ed.current?.getPosition()?.lineNumber);
      if (bps?.length) setTimeout(() => { for (const b of bps) setBreakpoint(monaco.Uri.file(p!).toString(), b.line, b); }, 300);
      return;
    }
    saveDocument(uri);
  };

  /** MATLAB-style Run: save, then execute the file by name so tracebacks and breakpoints point at it. */
  const run = async () => {
    const text = ed.current?.getValue() ?? "";
    if (path) {
      if (dirty) await doSave();
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
    if (dirty) await doSave();
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

  useEffect(() => () => closeDocument(uri), []);
  useEffect(() => { setDirtyPanel(id, path ? path.split("/").pop()! : "untitled.py", dirty); }, [dirty, path]);
  useEffect(() => () => setDirtyPanel(id, "", false), []);

  const onMount: OnMount = (editor, m) => {
    ed.current = editor;
    if (import.meta.env.DEV && (window as any).pide) (window as any).pide.editor = editor;
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => editors.get(id)?.runCell());
    editor.addCommand(m.KeyCode.F5, () => { if (get().debug.stopped) cont(); else editors.get(id)?.run(); });
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => editors.get(id)?.save());
    editor.addCommand(m.KeyCode.F9, () => editors.get(id)?.runCell());
    editor.addCommand(m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF, () => editors.get(id)?.format());
    openDocument(uri, editor.getValue());
    const lint = () => { const model = editor.getModel(); if (model) scheduleLint(m, model, path?.split("/").pop() ?? "untitled.py"); };
    lint();
    editor.onDidChangeModelContent(() => {
      setDirty(true);
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
  }, [bpLines, content]);
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
  }, [debug.stopped, debug.frameId, debug.frames, content]);

  if (loadError && loadError !== "retry") return <div className="vv-error">Could not open {path}: {loadError} <button onClick={() => setLoadError("retry")}>Retry</button></div>;
  if (content === null) return <div className="vv-loading">Loading…</div>;
  return (
    <div className="editor-panel">
      <MonacoEditor
        path={uri}
        language="python"
        theme={theme === "dark" ? "vs-dark" : "vs"}
        defaultValue={content}
        onMount={onMount}
        options={{ fontSize: 13, glyphMargin: true, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false, renderLineHighlight: "all", tabSize: 4, quickSuggestions: { other: true, comments: false, strings: false }, suggestOnTriggerCharacters: true, parameterHints: { enabled: true } }}
      />
    </div>
  );
}
