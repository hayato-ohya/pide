import { useState } from "react";
import { copyToGlobals, fetchVariables, frameLabel, selectFrame, type DapVar } from "../debug";
import { useStore } from "../store";

/** Workspace contents while the debugger is stopped: the selected frame's variables (expandable). */
export default function DebugVariables() {
  const debug = useStore((s) => s.debug);
  const [open, setOpen] = useState<Record<number, DapVar[]>>({});
  const frame = debug.frames.find((f) => f.id === debug.frameId);

  const toggle = async (v: DapVar) => {
    if (!v.variablesReference) return;
    if (open[v.variablesReference]) { const o = { ...open }; delete o[v.variablesReference]; setOpen(o); return; }
    const kids = await fetchVariables(v.variablesReference).catch(() => []);
    setOpen({ ...open, [v.variablesReference]: kids });
  };
  const render = (vars: DapVar[], depth: number): JSX.Element[] =>
    vars.flatMap((v) => [
      <tr key={depth + v.name + v.variablesReference} onDoubleClick={() => toggle(v)} title={v.value}>
        <td className="name" style={{ paddingLeft: 6 + depth * 14 }}>
          <span className="tw">{v.variablesReference ? (open[v.variablesReference] ? "▾ " : "▸ ") : "  "}</span>{v.name}
        </td>
        <td className="val">{v.value}</td>
        <td className="muted">{v.type ?? ""}</td>
        <td><button className="mini" title="Copy into kernel globals so the Workspace and viewers can use it" onClick={() => frame && copyToGlobals(v.name, frame.id)}>→ ws</button></td>
      </tr>,
      ...(open[v.variablesReference] ? render(open[v.variablesReference], depth + 1) : []),
    ]);

  return (
    <div className="workspace debug">
      <div className="panel-toolbar debug-bar">
        <span className="debug-tag">K&gt;&gt;</span>
        <select value={debug.frameId ?? ""} onChange={(e) => selectFrame(Number(e.target.value))} title="Call stack">
          {debug.frames.map((f) => <option key={f.id} value={f.id}>{f.name} · {frameLabel(f.path, f.line)}</option>)}
        </select>
        <span className="muted">{debug.reason}</span>
      </div>
      <div className="grid-wrap">
        <table className="grid ws-grid">
          <thead><tr><th>Name</th><th>Value</th><th>Class</th><th></th></tr></thead>
          <tbody>{render(debug.variables, 0)}</tbody>
        </table>
      </div>
    </div>
  );
}
