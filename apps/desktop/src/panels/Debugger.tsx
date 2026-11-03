import { clearBreakpoints, selectFrame, toggleBreakpoint, cont, stepIn, stepOut, stepOver, stopDebugger, editorPathFor, frameLabel, setExceptionFilters } from "../debug";
import { set } from "../store";
import { useStore } from "../store";
import { revealInEditor } from "../layout";

/** Call stack and breakpoints, like MATLAB's debugger sidebar. */
export default function Debugger() {
  const debug = useStore((s) => s.debug);
  const bps = Object.entries(debug.breakpoints);
  const nbp = bps.reduce((n, [, l]) => n + l.length, 0);
  return (
    <div className="debugger">
      <div className="panel-toolbar">
        <span className={`debug-state ${debug.active ? (debug.stopped ? "stopped" : "running") : ""}`}>{debug.active ? (debug.stopped ? `Stopped (${debug.reason})` : "Running") : "Not debugging"}</span>
        <button disabled={!debug.stopped} onClick={cont} title="F5">▶ Continue</button>
        <button disabled={!debug.stopped} onClick={stepOver} title="F10">⤼ Step</button>
        <button disabled={!debug.stopped} onClick={stepIn} title="F11">⤵ In</button>
        <button disabled={!debug.stopped} onClick={stepOut} title="Shift+F11">⤴ Out</button>
        <button disabled={!debug.active} onClick={stopDebugger}>■ Stop</button>
      </div>
      <div className="git-section-h"><span>Exceptions</span></div>
      <div className="dbg-ex">
        <label><input type="checkbox" checked={debug.exceptions.uncaught} onChange={(e) => setExceptionFilters({ ...debug.exceptions, uncaught: e.target.checked })} /> Break on uncaught</label>
        <label><input type="checkbox" checked={debug.exceptions.raised} onChange={(e) => setExceptionFilters({ ...debug.exceptions, raised: e.target.checked })} /> Break on raised (incl. handled)</label>
      </div>
      {debug.exceptionInfo && (
        <div className="dbg-exinfo">
          <div className="dbg-exid">{debug.exceptionInfo.id}</div>
          <div>{debug.exceptionInfo.description}</div>
          {debug.exceptionInfo.details && <pre>{debug.exceptionInfo.details}</pre>}
        </div>
      )}
      <div className="git-section-h"><span>Call stack</span></div>
      {debug.frames.length === 0 && <div className="muted" style={{ padding: 6 }}>Run with "Debug File" / "Debug Cell" and hit a breakpoint.</div>}
      {debug.frames.map((f) => (
        <div key={f.id} className={`git-file ${f.id === debug.frameId ? "selected" : ""}`} onClick={() => selectFrame(f.id)} onDoubleClick={() => { const m = editorPathFor(f.path); if (m) revealInEditor(m.uri, m.line(f.line)); }}>
          <span className="git-path">{f.name}</span>
          <span className="muted">{frameLabel(f.path, f.line)}</span>
        </div>
      ))}
      <div className="git-section-h"><span>Breakpoints ({nbp})</span><span className="git-actions"><button onClick={clearBreakpoints}>clear all</button></span></div>
      {bps.flatMap(([path, list]) => list.map((b) => (
        <div key={path + b.line} className="git-file" onDoubleClick={() => revealInEditor(path, b.line)} title="Double-click to go to; click ✎ to edit">
          <span className={`bp-dot ${b.logMessage ? "log" : b.condition || b.hitCondition ? "cond" : ""}`} onClick={() => toggleBreakpoint(path, b.line)} title="Remove" />
          <span className="git-path">{path.startsWith("vscode-notebook-cell:") ? decodeURIComponent(new URL(path).pathname).split("/").pop() + " cell" : path.split("/").pop()}:{b.line}</span>
          <span className="muted bp-meta">{b.condition ? `if ${b.condition}` : ""}{b.hitCondition ? ` hit ${b.hitCondition}` : ""}{b.logMessage ? ` log "${b.logMessage}"` : ""}</span>
          <button className="mini" onClick={() => set({ bpEdit: { uri: path, line: b.line } })}>✎</button>
        </div>
      )))}
    </div>
  );
}
