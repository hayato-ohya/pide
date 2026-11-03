import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { gitCall, layoutGraph, refreshGit, type Commit, type FileDiff, type StatusEntry } from "../git";
import { openDiff } from "../layout";

const COLORS = ["#0076a8", "#d9534f", "#5cb85c", "#f0ad4e", "#8e44ad", "#17a2b8", "#e83e8c", "#6c757d"];

function ago(t: number) {
  const s = Date.now() / 1000 - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(t * 1000).toLocaleDateString();
}

function Section({ title, entries, actions, onOpen }: { title: string; entries: StatusEntry[]; actions: { label: string; fn: (paths: string[]) => void; danger?: boolean }[]; onOpen: (e: StatusEntry) => void }) {
  const [open, setOpen] = useState(true);
  if (!entries.length) return null;
  return (
    <div className="git-section">
      <div className="git-section-h" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} {title} <span className="muted">({entries.length})</span></span>
        <span className="git-actions">{actions.map((a) => <button key={a.label} className={a.danger ? "danger" : ""} onClick={(ev) => { ev.stopPropagation(); a.fn(entries.map((e) => e.path)); }}>{a.label} all</button>)}</span>
      </div>
      {open && entries.map((e) => (
        <div key={e.area + e.path} className="git-file" onDoubleClick={() => onOpen(e)}>
          <span className={`git-code c-${e.code[0]}`}>{e.code}</span>
          <span className="git-path" title={e.path}>{e.path}</span>
          <span className="git-actions">{actions.map((a) => <button key={a.label} className={a.danger ? "danger" : ""} onClick={() => a.fn([e.path])}>{a.label}</button>)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Git() {
  const git = useStore((s) => s.git);
  const cwd = useStore((s) => s.cwd);
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [branches, setBranches] = useState<{ name: string; remote: boolean; current: boolean }[]>([]);

  useEffect(() => { refreshGit(); }, [cwd]);

  const st = git.status;
  const abs = (p: string) => `${st?.root}/${p}`;
  const staged = st?.entries.filter((e) => e.area === "staged") ?? [];
  const unstaged = st?.entries.filter((e) => e.area === "unstaged") ?? [];
  const untracked = st?.entries.filter((e) => e.area === "untracked") ?? [];
  const conflicted = st?.entries.filter((e) => e.area === "conflicted") ?? [];
  const graph = useMemo(() => layoutGraph(git.log), [git.log]);

  const openEntry = async (e: StatusEntry) => {
    const diffs = await invoke<FileDiff[]>("git_diff", { cwd, staged: e.area === "staged", path: abs(e.path) }).catch(() => []);
    const d = diffs.find((x) => x.path === e.path) ?? diffs[0];
    if (d) openDiff(d, e.area === "staged" ? "index" : "working tree");
  };
  const selectCommit = async (c: Commit) => {
    setSel(c.id);
    setFiles(await invoke<FileDiff[]>("git_commit_diff", { cwd, id: c.id }).catch(() => []));
  };
  const commit = async () => {
    if (!msg.trim() && !amend) return;
    const id = await gitCall<string>("git_commit", { message: msg, amend });
    if (id) { setMsg(""); setAmend(false); }
  };
  const loadBranches = async () => setBranches((await invoke<any[]>("git_branches", { cwd }).catch(() => [])) ?? []);

  if (git.error) {
    return (
      <div className="git">
        <div className="center muted">
          <div>{git.error}<br /><br /><button onClick={() => gitCall("git_init")}>git init here</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="git">
      <div className="panel-toolbar git-head">
        <select className="branch" value={st?.branch ?? ""} onFocus={loadBranches} onChange={async (e) => {
          if (e.target.value === "__new__") { const n = prompt("New branch name"); if (n) await gitCall("git_create_branch", { name: n }); }
          else await gitCall("git_checkout", { name: e.target.value });
        }} title={st?.upstream ? `upstream ${st.upstream}` : "no upstream"}>
          <option value={st?.branch ?? ""}>{st?.detached ? `(detached ${st.head?.slice(0, 7)})` : st?.branch ?? "(no commits)"}</option>
          {branches.filter((b) => b.name !== st?.branch).map((b) => <option key={b.name} value={b.name}>{b.remote ? "☁ " : ""}{b.name}</option>)}
          <option value="__new__">＋ new branch…</option>
        </select>
        {st && (st.ahead > 0 || st.behind > 0) && <span className="muted">↑{st.ahead} ↓{st.behind}</span>}
        <span className="git-tabs">
          <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>Changes {st?.entries.length ? `(${st.entries.length})` : ""}</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
        </span>
        <button onClick={refreshGit} title="Refresh">⟳</button>
      </div>

      {tab === "changes" && (
        <div className="git-body">
          <div className="git-commit">
            <textarea placeholder="Commit message (Cmd+Enter to commit)" value={msg} onChange={(e) => setMsg(e.target.value)} rows={3}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(); }} />
            <div className="git-commit-row">
              <label><input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> amend</label>
              <button className="primary" disabled={!staged.length && !amend} onClick={commit}>Commit{staged.length ? ` ${staged.length} file${staged.length > 1 ? "s" : ""}` : ""}</button>
            </div>
          </div>
          <div className="git-lists">
            <Section title="Conflicts" entries={conflicted} onOpen={openEntry} actions={[{ label: "stage", fn: (p) => gitCall("git_stage", { paths: p.map(abs) }) }]} />
            <Section title="Staged" entries={staged} onOpen={openEntry} actions={[{ label: "unstage", fn: (p) => gitCall("git_unstage", { paths: p.map(abs) }) }]} />
            <Section title="Changes" entries={unstaged} onOpen={openEntry} actions={[{ label: "stage", fn: (p) => gitCall("git_stage", { paths: p.map(abs) }) }, { label: "discard", danger: true, fn: (p) => { if (confirm(`Discard changes in ${p.length} file(s)?`)) gitCall("git_discard", { paths: p.map(abs) }); } }]} />
            <Section title="Untracked" entries={untracked} onOpen={openEntry} actions={[{ label: "stage", fn: (p) => gitCall("git_stage", { paths: p.map(abs) }) }]} />
            {st && !st.entries.length && <div className="muted center">Working tree clean</div>}
          </div>
        </div>
      )}

      {tab === "history" && (
        <div className="git-body">
          <div className="git-log">
            {git.log.map((c, i) => {
              const row = graph[i];
              const W = 14, H = 24;
              const maxLane = Math.max(row.lane, ...row.lanes.map((_, j) => j), ...row.links.map((l) => Math.max(l.from, l.to)));
              return (
                <div key={c.id} className={`git-row ${sel === c.id ? "selected" : ""}`} onClick={() => selectCommit(c)}>
                  <svg width={(maxLane + 1) * W + 4} height={H} className="git-graph">
                    {row.lanes.map((id, j) => id && <line key={"v" + j} x1={j * W + W / 2} y1={0} x2={j * W + W / 2} y2={H} stroke={COLORS[j % COLORS.length]} strokeWidth={2} />)}
                    {row.links.map((l, k) => <path key={"l" + k} d={`M ${l.from * W + W / 2} ${H / 2} C ${l.from * W + W / 2} ${H}, ${l.to * W + W / 2} ${H / 2}, ${l.to * W + W / 2} ${H}`} stroke={COLORS[l.color % COLORS.length]} strokeWidth={2} fill="none" />)}
                    {c.parents.length > 0 && <line x1={row.lane * W + W / 2} y1={H / 2} x2={row.lane * W + W / 2} y2={H} stroke={COLORS[row.lane % COLORS.length]} strokeWidth={2} />}
                    <circle cx={row.lane * W + W / 2} cy={H / 2} r={4} fill={COLORS[row.lane % COLORS.length]} stroke="#fff" strokeWidth={1.5} />
                  </svg>
                  <span className="git-refs">{c.refs.map((r) => <span key={r} className={`ref ${r === "HEAD" ? "head" : r.includes("/") ? "remote" : "local"}`}>{r}</span>)}</span>
                  <span className="git-summary" title={c.body}>{c.summary}</span>
                  <span className="git-meta muted">{c.author} · {ago(c.time)} · {c.short}</span>
                </div>
              );
            })}
            {!git.log.length && <div className="muted center">No commits yet</div>}
          </div>
          {sel && (
            <div className="git-commit-files">
              <div className="git-section-h"><span>{files.length} file{files.length !== 1 ? "s" : ""} changed in {sel.slice(0, 7)}</span></div>
              {files.map((f) => (
                <div key={f.path} className="git-file" onDoubleClick={() => openDiff(f, sel.slice(0, 7))}>
                  <span className={`git-code c-${f.code}`}>{f.code}</span>
                  <span className="git-path" title={f.path}>{f.path}</span>
                  <span className="muted">+{f.additions} −{f.deletions}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
