// Git state shared by the Git panel, file tree badges and diff viewers.
import { invoke } from "@tauri-apps/api/core";
import { get, pushConsole, set } from "./store";
import { reloadOpenFiles } from "./reload";

export interface StatusEntry { path: string; old_path?: string | null; area: "staged" | "unstaged" | "untracked" | "conflicted"; code: string }
export interface GitStatus { state: "clean" | "merge" | "rebase" | "cherrypick" | "revert" | "bisect" | "other"; root: string; branch: string | null; head: string | null; detached: boolean; ahead: number; behind: number; upstream: string | null; entries: StatusEntry[] }
export interface Commit { id: string; short: string; parents: string[]; summary: string; body: string; author: string; email: string; time: number; refs: string[] }
export interface FileDiff { path: string; old_path: string | null; code: string; old: string | null; new: string | null; binary: boolean; additions: number; deletions: number }

export async function refreshGit() {
  const cwd = get().cwd;
  if (!cwd || get().remote || get().connectionFile) { if (get().git.status) set({ git: { status: null, log: [], error: null } }); return; }
  try {
    const status = await invoke<GitStatus>("git_status", { cwd });
    const log = await invoke<Commit[]>("git_log", { cwd, limit: 300, all: true });
    set({ git: { status, log, error: null } });
  } catch (e) {
    set({ git: { status: null, log: [], error: String(e) } });
  }
}

export const gitCall = async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T | undefined> => {
  const cwd = get().cwd;
  try {
    const r = await invoke<T>(cmd, { cwd, ...args });
    await refreshGit();
    reloadOpenFiles();
    return r;
  } catch (e) {
    pushConsole({ kind: "info", text: `git: ${e}` });
    return undefined;
  }
};

/** Map of workdir-relative path → status code, for tree badges. */
export function statusMap(): Map<string, string> {
  const m = new Map<string, string>();
  const st = get().git.status;
  if (!st) return m;
  for (const e of st.entries) {
    const prev = m.get(e.path);
    m.set(e.path, prev && prev !== e.code ? prev + e.code : e.code);
  }
  return m;
}

// ---- commit graph lane assignment (first-parent keeps lane; others branch) ----
export interface GraphRow { lane: number; lanes: (string | null)[]; links: { from: number; to: number; color: number }[] }
export function layoutGraph(commits: Commit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let active: (string | null)[] = []; // lane i expects commit id
  for (const c of commits) {
    let lane = active.indexOf(c.id);
    if (lane === -1) {
      lane = active.indexOf(null);
      if (lane === -1) { lane = active.length; active.push(c.id); } else active[lane] = c.id;
    }
    // Remove other lanes that also wait for this commit (merges into it).
    const incoming = active.map((id, i) => (id === c.id && i !== lane ? i : -1)).filter((i) => i >= 0);
    const links: GraphRow["links"] = [];
    for (const i of incoming) { links.push({ from: i, to: lane, color: i }); active[i] = null; }
    const before = active.slice();
    // Parents: first parent continues in this lane; others get new lanes.
    const [p0, ...rest] = c.parents;
    active[lane] = p0 ?? null;
    for (const p of rest) {
      let pl = active.indexOf(p);
      if (pl === -1) { pl = active.indexOf(null); if (pl === -1) { pl = active.length; active.push(p); } else active[pl] = p; }
      links.push({ from: lane, to: pl, color: pl });
    }
    if (p0) { const dup = active.findIndex((id, i) => id === p0 && i !== lane); if (dup >= 0) { links.push({ from: lane, to: dup, color: dup }); active[lane] = null; } }
    rows.push({ lane, lanes: before, links });
    while (active.length && active[active.length - 1] === null) active.pop();
  }
  return rows;
}
