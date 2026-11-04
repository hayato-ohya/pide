import { useEffect, useState } from "react";
import { set, useStore } from "../store";
import Modal from "./Modal";

export default function PromptDialog() {
  const req = useStore((s) => s.promptReq);
  const [v, setV] = useState("");
  useEffect(() => { setV(req?.value ?? ""); }, [req]);
  if (!req) return null;
  const done = (val: string | null) => { set({ promptReq: null }); req.resolve(val); };
  return (
    <Modal title={req.message} width={460} onClose={() => done(null)} onEnter={() => done(v.trim() || null)}>
      <div className="row"><input aria-label={req.message} value={v} placeholder={req.placeholder} onChange={(e) => setV(e.target.value)} /></div>
      <div className="row buttons"><button className="primary" onClick={() => done(v.trim() || null)}>OK</button><button onClick={() => done(null)}>Cancel</button></div>
    </Modal>
  );
}
