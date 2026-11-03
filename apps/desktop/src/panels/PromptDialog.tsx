import { useEffect, useState } from "react";
import { set, useStore } from "../store";

export default function PromptDialog() {
  const req = useStore((s) => s.promptReq);
  const [v, setV] = useState("");
  useEffect(() => { setV(req?.value ?? ""); }, [req]);
  if (!req) return null;
  const done = (val: string | null) => { set({ promptReq: null }); req.resolve(val); };
  return (
    <div className="modal-bg" onClick={() => done(null)}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>{req.message}</h3>
        <div className="row"><input autoFocus value={v} placeholder={req.placeholder} onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") done(v.trim() || null); if (e.key === "Escape") done(null); }} /></div>
        <div className="row buttons"><button className="primary" onClick={() => done(v.trim() || null)}>OK</button><button onClick={() => done(null)}>Cancel</button></div>
      </div>
    </div>
  );
}
