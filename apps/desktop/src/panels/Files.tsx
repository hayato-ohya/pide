import { useEffect, useState } from "react";
import { setCwd } from "../kernel";
import { useStore } from "../store";
import { openFile } from "../layout";
import { statusMap } from "../git";
import { isRemote, listDir } from "../fs";
import { usePageVisible, usePanelVisible } from "../visibility";
import type { IDockviewPanelProps } from "dockview";

import type { Entry } from "../fs";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Files(props: IDockviewPanelProps) {
  const active = usePanelVisible(props.api) && usePageVisible();
  const cwd = useStore((s) => s.cwd);
  const kernel = useStore((s) => s.kernel);
  const remote = useStore((s) => s.remote);
  const connectionFile = useStore((s) => s.connectionFile);
  const git = useStore((s) => s.git);
  const badges = statusMap();
  const root = git.status?.root;
  const badge = (p: string, isDir: boolean) => {
    if (!root || !p.startsWith(root)) return null;
    const rel = p.slice(root.length + 1);
    if (!isDir) return badges.get(rel) ?? null;
    for (const k of badges.keys()) if (k.startsWith(rel + "/")) return "•";
    return null;
  };
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!cwd) return;
    if (isRemote() && kernel !== "idle") return; // remote listing needs the kernel
    try {
      setEntries(await listDir(cwd));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (!active) return; // hidden panels do not poll; reload on reveal
    load();
    const t = setInterval(load, isRemote() ? 8000 : 3000);
    return () => clearInterval(t);
  }, [cwd, kernel, remote, connectionFile, active]);

  const up = () => {
    if (!cwd) return;
    const parent = cwd.replace(/\/[^/]+\/?$/, "");
    // "C:" → "C:/" on Windows; "" → "/" elsewhere.
    setCwd(/^[A-Za-z]:$/.test(parent) ? parent + "/" : parent || "/");
  };

  return (
    <div className="files">
      <div className="files-path">
        {(remote || connectionFile) && <span className="files-remote" title="Browsing the kernel's machine">{remote?.host ?? "remote"}</span>}
        <button onClick={up} title="Up one level" aria-label="Up one level">↑</button>
        <input aria-label="Current folder" value={cwd ?? ""} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
      </div>
      {error && <div className="c-info">{error}</div>}
      <table className="grid" aria-label="Files" onKeyDown={(e) => {
        if (!entries.length) return;
        const table = e.currentTarget;
        const go = (j: number) => { const n = Math.max(0, Math.min(entries.length - 1, j)); setCursor(n); requestAnimationFrame(() => table.querySelectorAll<HTMLElement>("tbody tr")[n]?.focus()); };
        if (e.key === "ArrowDown") { e.preventDefault(); go(cursor + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); go(cursor - 1); }
        else if (e.key === "Enter") { e.preventDefault(); const x = entries[cursor]; if (x) x.is_dir ? setCwd(x.path) : openFile(x.path); }
        else if (e.key === "Backspace") { e.preventDefault(); up(); }
      }}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Size</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={e.path} tabIndex={i === cursor ? 0 : -1} className={i === cursor ? "cursor" : ""} onFocus={() => setCursor(i)} onClick={() => setCursor(i)} onDoubleClick={() => (e.is_dir ? setCwd(e.path) : openFile(e.path))}>
              <td className={e.is_dir ? "dir" : "file"}>
                {e.is_dir ? "📁 " : e.name.endsWith(".py") ? "🐍 " : e.name.endsWith(".ipynb") ? "📓 " : "📄 "}
                {e.name}
                {badge(e.path, e.is_dir) && <span className={`git-badge c-${badge(e.path, e.is_dir)![0]}`}>{badge(e.path, e.is_dir)}</span>}
              </td>
              <td className="num">{e.is_dir ? "" : fmtSize(e.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
