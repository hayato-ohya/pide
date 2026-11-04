import { useState } from "react";
import { getBreakpoint, setBreakpoint, toggleBreakpoint } from "../debug";
import { set, useStore } from "../store";
import Modal from "./Modal";

/** Modal to edit a breakpoint's condition / hit count / log message. Opened via store.bpEdit. */
export default function BreakpointDialog() {
  const req = useStore((s) => s.bpEdit);
  if (!req) return null;
  return <Inner key={req.uri + req.line} uri={req.uri} line={req.line} />;
}

function Inner({ uri, line }: { uri: string; line: number }) {
  const existing = getBreakpoint(uri, line);
  const [condition, setCondition] = useState(existing?.condition ?? "");
  const [hit, setHit] = useState(existing?.hitCondition ?? "");
  const [log, setLog] = useState(existing?.logMessage ?? "");
  const close = () => set({ bpEdit: null });
  const save = () => { setBreakpoint(uri, line, { condition, hitCondition: hit, logMessage: log }); close(); };
  const name = uri.startsWith("vscode-notebook-cell:") ? "cell" : decodeURIComponent(uri).split("/").pop();
  return (
    <Modal title={`Breakpoint · ${name}:${line}`} onClose={close} onEnter={save}>
        <div className="row"><label htmlFor="bp-cond">Condition</label><input id="bp-cond" value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="Python expression, e.g. i == 3 or loss > 1.0" /></div>
        <div className="row"><label htmlFor="bp-hit">Hit count</label><input id="bp-hit" value={hit} onChange={(e) => setHit(e.target.value)} placeholder="e.g. 5, >= 3, % 10" /></div>
        <div className="row"><label htmlFor="bp-log">Log message</label><input id="bp-log" value={log} onChange={(e) => setLog(e.target.value)} placeholder="Logpoint: prints instead of stopping, e.g. i={i} loss={round(loss, 3)}" /></div>
        <p className="muted">Leave all empty for a plain breakpoint. Logpoints print to the Command Window and do not pause. Use {"{expression}"} (format specs like :.3f are not supported by debugpy).</p>
        <div className="row buttons">
          <button className="primary" onClick={save}>{existing ? "Update" : "Add"}</button>
          {existing && <button className="danger" onClick={() => { toggleBreakpoint(uri, line); close(); }}>Remove</button>}
          <button onClick={close}>Cancel</button>
        </div>
    </Modal>
  );
}
