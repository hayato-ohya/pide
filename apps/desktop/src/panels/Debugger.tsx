import { clearBreakpoints, selectFrame, toggleBreakpoint, cont, stepIn, stepOut, stepOver, stopDebugger, editorPathFor, frameLabel } from "../debug";
import { useStore } from "../store";
import { revealInEditor } from "../layout";

/** Call stack and breakpoints, like MATLAB's debugger sidebar. */
export default function Debugger() {
  const debug = useStore((s) => s.debug);
  const bps = Object.entries(debug.breakpoints);
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
      <div className="git-section-h"><span>Call stack</span></div>
      {debug.frames.length === 0 && <div className="muted" style={{ padding: 6 }}>Run with "Debug File" / "Debug Cell" and hit a breakpoint.</div>}
      {debug.frames.map((f) => (
        <div key={f.id} className={`git-file ${f.id === debug.frameId ? "selected" : ""}`} onClick={() => selectFrame(f.id)} onDoubleClick={() => { const m = editorPathFor(f.path); if (m) revealInEditor(m.uri, m.line(f.line)); }}>
          <span className="git-path">{f.name}</span>
          <span className="muted">{frameLabel(f.path, f.line)}</span>
        </div>
      ))}
      <div className="git-section-h"><span>Breakpoints ({bps.reduce((n, [, l]) => n + l.length, 0)})</span><span className="git-actions"><button onClick={clearBreakpoints}>clear all</button></span></div>
      {bps.flatMap(([path, lines]) => lines.map((l) => (
        <div key={path + l} className="git-file" onDoubleClick={() => revealInEditor(path, l)}>
          <span className="bp-dot" onClick={() => toggleBreakpoint(path, l)} title="Remove" />
          <span className="git-path">{path.split("/").pop()}</span>
          <span className="muted">line {l}</span>
        </div>
      )))}
    </div>
  );
}
