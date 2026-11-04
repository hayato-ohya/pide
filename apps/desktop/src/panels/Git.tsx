import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pushConsole, useStore } from "../store";
import { gitCall, layoutGraph, refreshGit, type Commit, type FileDiff, type StatusEntry } from "../git";
import { openConflict, openDiff } from "../layout";
import { usePanelVisible } from "../visibility";
import type { IDockviewPanelProps } from "dockview";
import { confirmAsync, promptAsync } from "../dialogs";

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

export default function Git(props: IDockviewPanelProps) {
  const visible = usePanelVisible(props.api);
  const git = useStore((s) => s.git);
  const cwd = useStore((s) => s.cwd);
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [branches, setBranches] = useState<{ name: string; remote: boolean; current: boolean }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<{ name: string; url: string }[] | null>(null);

  /** Run a network operation and report its outcome in the console. */
  const net = async (label: string, cmd: string, args: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(label);
    try {
      const r = await invoke<{ ok: boolean; stdout: string; stderr: string }>(cmd, { cwd, ...args });
      const text = (r.stdout + "\n" + r.stderr).trim();
      pushConsole({ kind: "info", text: `git ${label}: ${r.ok ? "ok" : "failed"}${text ? "\n" + text : ""}` });
      if (!r.ok && /could not read Username|Permission denied|publickey|Authentication failed/i.test(r.stderr)) pushConsole({ kind: "info", text: "Hint: Pide never prompts for credentials. Set up an SSH key / ssh-agent or a git credential helper, then retry." });
    } catch (e) {
      pushConsole({ kind: "info", text: `git ${label}: ${e}` });
    } finally {
      setBusy(null);
      refreshGit();
    }
  };
  const addRemote = async () => {
    const url = await promptAsync("Remote URL (origin)", "", "git@github.com:user/repo.git");
    if (!url) return;
    await gitCall("git_add_remote", { name: "origin", url });
    setRemotes(await invoke<any[]>("git_remotes", { cwd }).catch(() => []));
  };
  useEffect(() => { if (cwd && !git.error) invoke<any[]>("git_remotes", { cwd }).then(setRemotes).catch(() => setRemotes([])); }, [cwd, git.status?.root, git.error]);

  useEffect(() => { if (visible) refreshGit(); }, [cwd, visible]);

  const st = git.status;
  const abs = (p: string) => `${st?.root}/${p}`;
  const staged = st?.entries.filter((e) => e.area === "staged") ?? [];
  const unstaged = st?.entries.filter((e) => e.area === "unstaged") ?? [];
  const untracked = st?.entries.filter((e) => e.area === "untracked") ?? [];
  const conflicted = st?.entries.filter((e) => e.area === "conflicted") ?? [];
  const graph = useMemo(() => layoutGraph(git.log), [git.log]);

  const resolve = async (paths: string[], side: "ours" | "theirs" | "workdir") => {
    for (const p of paths) {
      try {
        await invoke("git_resolve", { cwd, path: p, side, allowMarkers: false });
      } catch (e) {
        if (/conflict markers/.test(String(e))) {
          if (!(await confirmAsync(`${p} still contains conflict markers. Mark it resolved anyway?`))) continue;
          await invoke("git_resolve", { cwd, path: p, side, allowMarkers: true }).catch((e2) => pushConsole({ kind: "info", text: `git: ${e2}` }));
        } else pushConsole({ kind: "info", text: `git: ${e}` });
      }
    }
    refreshGit();
  };
  const mergeBranch = async () => {
    await loadBranches();
    const name = await promptAsync("Merge branch into " + (st?.branch ?? "HEAD"), "", branches.find((b) => !b.current && !b.remote)?.name ?? "");
    if (name) net(`merge ${name}`, "git_merge", { branch: name });
  };
  const opLabel = { merge: "Merge", rebase: "Rebase", cherrypick: "Cherry-pick", revert: "Revert", bisect: "Bisect", other: "Operation", clean: "" }[st?.state ?? "clean"];

  const openEntry = async (e: StatusEntry) => {
    if (e.area === "conflicted") { openConflict(e.path); return; }
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

  const remoteKernel = useStore((s) => !!(s.remote || s.connectionFile));
  if (remoteKernel) return <div className="git"><div className="center muted">Git is not available while a remote kernel is selected (the Current Folder shows the remote machine).</div></div>;
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
          if (e.target.value === "__new__") { const n = await promptAsync("New branch name"); if (n) await gitCall("git_create_branch", { name: n }); }
          else await gitCall("git_checkout", { name: e.target.value });
        }} title={st?.upstream ? `upstream ${st.upstream}` : "no upstream"}>
          <option value={st?.branch ?? ""}>{st?.detached ? `(detached ${st.head?.slice(0, 7)})` : st?.branch ?? "(no commits)"}</option>
          {branches.filter((b) => b.name !== st?.branch).map((b) => <option key={b.name} value={b.name}>{b.remote ? "☁ " : ""}{b.name}</option>)}
          <option value="__new__">＋ new branch…</option>
        </select>
        <button disabled={!!busy || st?.state !== "clean"} onClick={mergeBranch} title="Merge another branch into the current one">⑂ Merge</button>
        {st && (st.ahead > 0 || st.behind > 0) && <span className="muted" title={`${st.ahead} to push, ${st.behind} to pull`}>↑{st.ahead} ↓{st.behind}</span>}
        <span className="git-net">
          {remotes && remotes.length === 0 ? (
            <button onClick={addRemote} title="No remote configured">＋ remote</button>
          ) : (
            <>
              <button disabled={!!busy} onClick={() => net("fetch", "git_fetch")} title="git fetch --all --prune">{busy === "fetch" ? "…" : "⇣ Fetch"}</button>
              <button disabled={!!busy || !st?.upstream} onClick={() => net("pull", "git_pull", { rebase: false })} title={st?.upstream ? "git pull --ff-only (Shift-click: --rebase)" : "No upstream branch"}
                onContextMenu={(e) => { e.preventDefault(); net("pull --rebase", "git_pull", { rebase: true }); }}>{busy?.startsWith("pull") ? "…" : `⇩ Pull${st?.behind ? ` ${st.behind}` : ""}`}</button>
              <button disabled={!!busy} onClick={() => net(st?.upstream ? "push" : "push -u", "git_push", { setUpstream: st?.upstream ? null : st?.branch, force: false })}
                title={st?.upstream ? "git push (right-click: --force-with-lease)" : `Publish ${st?.branch} to origin`}
                onContextMenu={async (e) => { e.preventDefault(); if (await confirmAsync("Force push (--force-with-lease)?")) net("push --force-with-lease", "git_push", { setUpstream: null, force: true }); }}>
                {busy?.startsWith("push") ? "…" : st?.upstream ? `⇧ Push${st?.ahead ? ` ${st.ahead}` : ""}` : "⇧ Publish"}
              </button>
            </>
          )}
        </span>
        <span className="git-tabs">
          <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>Changes {st?.entries.length ? `(${st.entries.length})` : ""}</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>
        </span>
        <button onClick={refreshGit} title="Refresh">⟳</button>
      </div>
      {st && st.state !== "clean" && (
        <div className="git-banner" role="status">
          <span>{opLabel} in progress{conflicted.length ? ` · ${conflicted.length} conflict${conflicted.length > 1 ? "s" : ""} to resolve` : " · all conflicts resolved"}</span>
          <span className="git-actions">
            <button disabled={!!busy || conflicted.length > 0} onClick={() => net(`${opLabel.toLowerCase()} --continue`, "git_continue")} title="Finish the operation (requires all conflicts staged)">Continue</button>
            <button className="danger" disabled={!!busy} onClick={async () => { if (await confirmAsync(`Abort the ${opLabel.toLowerCase()}? Your working tree returns to the state before it started.`)) net(`${opLabel.toLowerCase()} --abort`, "git_abort"); }}>Abort</button>
          </span>
        </div>
      )}

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
            <Section title="Conflicts" entries={conflicted} onOpen={openEntry} actions={[
              { label: "ours", fn: (p) => resolve(p, "ours") },
              { label: "theirs", fn: (p) => resolve(p, "theirs") },
              { label: "resolved", fn: (p) => resolve(p, "workdir") },
            ]} />
            <Section title="Staged" entries={staged} onOpen={openEntry} actions={[{ label: "unstage", fn: (p) => gitCall("git_unstage", { paths: p.map(abs) }) }]} />
            <Section title="Changes" entries={unstaged} onOpen={openEntry} actions={[{ label: "stage", fn: (p) => gitCall("git_stage", { paths: p.map(abs) }) }, { label: "discard", danger: true, fn: async (p) => { if (await confirmAsync(`Discard changes in ${p.length} file(s)? This cannot be undone.`)) gitCall("git_discard", { paths: p.map(abs) }); } }]} />
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
                <div key={f.path} className="git-file" onDoubleClick={async () => { const full = await invoke<FileDiff | null>("git_commit_file", { cwd, id: sel, path: f.path }).catch(() => null); openDiff(full ?? f, sel.slice(0, 7)); }}>
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
