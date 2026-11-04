import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { restartKernel, setConnectionFile, setRemote } from "../kernel";
import { readJson, useStore } from "../store";
import Modal from "./Modal";

interface Profile { name: string; host: string; port?: number | null; python: string; cwd?: string | null }

/** Choose a remote kernel: an SSH profile or an existing connection file. */
export default function RemoteDialog({ onClose }: { onClose: () => void }) {
  const remote = useStore((s) => s.remote);
  const [profiles, setProfiles] = useState<Profile[]>(() => readJson<Profile[]>("pide.remoteProfiles", []));
  const [p, setP] = useState<Profile>({ name: "", host: remote?.host ?? "", port: remote?.port ?? null, python: remote?.python ?? "python3", cwd: remote?.cwd ?? "" });
  const save = (list: Profile[]) => { setProfiles(list); localStorage.setItem("pide.remoteProfiles", JSON.stringify(list)); };

  const connect = async () => {
    if (!p.host || !p.python) return;
    if (p.name) save([...profiles.filter((x) => x.name !== p.name), { ...p }]);
    setRemote({ host: p.host, port: p.port || null, python: p.python, cwd: p.cwd || null });
    onClose();
    await restartKernel();
  };
  const pickFile = async () => {
    const f = await open({ multiple: false, filters: [{ name: "Jupyter connection file", extensions: ["json"] }] });
    if (typeof f === "string") { setConnectionFile(f); onClose(); await restartKernel(); }
  };

  return (
    <Modal title="Remote kernel (SSH)" onClose={onClose} onEnter={connect}>
        <p className="muted">The remote interpreter needs <code>ipykernel</code> (and <code>debugpy</code> for debugging). The helper package is uploaded automatically to <code>~/.pide</code>. Key-based SSH login is required (no password prompt).</p>
        {profiles.length > 0 && (
          <div className="row"><label htmlFor="rd-saved">Saved</label>
            <select id="rd-saved" value="" onChange={(e) => { const x = profiles.find((y) => y.name === e.target.value); if (x) setP({ ...x }); }}>
              <option value="">choose…</option>{profiles.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.host})</option>)}
            </select>
            <button onClick={() => p.name && save(profiles.filter((x) => x.name !== p.name))} aria-label="Delete saved profile">delete</button>
          </div>
        )}
        <div className="row"><label htmlFor="rd-name">Profile name</label><input id="rd-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="gpu-box (optional)" /></div>
        <div className="row"><label htmlFor="rd-host">Host</label><input id="rd-host" value={p.host} onChange={(e) => setP({ ...p, host: e.target.value })} placeholder="user@server" /><input className="small" aria-label="SSH port" value={p.port ?? ""} onChange={(e) => setP({ ...p, port: e.target.value ? Number(e.target.value) : null })} placeholder="22" /></div>
        <div className="row"><label htmlFor="rd-python">Remote python</label><input id="rd-python" value={p.python} onChange={(e) => setP({ ...p, python: e.target.value })} placeholder="/home/me/miniconda3/envs/ml/bin/python" /></div>
        <div className="row"><label htmlFor="rd-cwd">Remote folder</label><input id="rd-cwd" value={p.cwd ?? ""} onChange={(e) => setP({ ...p, cwd: e.target.value })} placeholder="~/project (optional)" /></div>
        <div className="row buttons">
          <button className="primary" onClick={connect}>Connect</button>
          <button onClick={pickFile} title="Attach to a running kernel (e.g. a container with published ports) using its connection file">Connection file…</button>
          <button onClick={onClose}>Cancel</button>
        </div>
    </Modal>
  );
}
