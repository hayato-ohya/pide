// Side-by-side view of a conflicted file: ours / theirs / base, with one-click resolution.
import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview";
import { pushConsole, useStore } from "../store";
import { refreshGit } from "../git";
import { openFile } from "../layout";
import { confirmAsync } from "../dialogs";

export interface Conflict { path: string; base: string | null; ours: string | null; theirs: string | null; workdir: string | null; binary: boolean }

function langOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ py: "python", json: "json", ipynb: "json", md: "markdown", toml: "ini", yaml: "yaml", yml: "yaml", js: "javascript", ts: "typescript", rs: "rust", html: "html", css: "css", sh: "shell" } as Record<string, string>)[ext ?? ""] ?? "plaintext";
}

type View = "ours-theirs" | "base-ours" | "base-theirs" | "ours-workdir";

export default function ConflictView(props: IDockviewPanelProps<{ path: string }>) {
  const cwd = useStore((s) => s.cwd);
  const theme = useStore((s) => s.theme);
  const root = useStore((s) => s.git.status?.root);
  const [c, setC] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("ours-theirs");
  const path = props.params.path;

  const load = () => invoke<Conflict>("git_conflict", { cwd, path }).then((x) => { setC(x); setError(null); }).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, [cwd, path]);

  const resolve = async (side: "ours" | "theirs" | "workdir") => {
    try {
      await invoke("git_resolve", { cwd, path, side, allowMarkers: false });
    } catch (e) {
      if (/conflict markers/.test(String(e))) {
        if (!(await confirmAsync("The file still contains conflict markers. Mark it resolved anyway?"))) return;
        try { await invoke("git_resolve", { cwd, path, side, allowMarkers: true }); } catch (e2) { pushConsole({ kind: "info", text: `git: ${e2}` }); return; }
      } else { pushConsole({ kind: "info", text: `git: ${e}` }); return; }
    }
    pushConsole({ kind: "info", text: `Resolved ${path} (${side})` });
    await refreshGit();
    props.api.close();
  };

  if (error) return <div className="vv-error">{error} <button onClick={load}>Retry</button></div>;
  if (!c) return <div className="vv-loading">Loading conflict…</div>;
  const pair: Record<View, [string, string | null, string, string | null]> = {
    "ours-theirs": ["Ours (HEAD)", c.ours, "Theirs (incoming)", c.theirs],
    "base-ours": ["Base", c.base, "Ours (HEAD)", c.ours],
    "base-theirs": ["Base", c.base, "Theirs (incoming)", c.theirs],
    "ours-workdir": ["Ours (HEAD)", c.ours, "Working tree", c.workdir],
  };
  const [lt, orig, rt, mod] = pair[view];
  const deleted = (t: string | null) => (t === null ? "(deleted / binary)" : t);
  return (
    <div className="diffview">
      <div className="panel-toolbar">
        <span className="git-tabs">
          {(["ours-theirs", "base-ours", "base-theirs", "ours-workdir"] as View[]).map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v.replace("-", " ⇄ ")}</button>)}
        </span>
        <span style={{ marginLeft: "auto" }} />
        <button onClick={() => resolve("ours")} title="Overwrite the file with our version and stage it">Take ours</button>
        <button onClick={() => resolve("theirs")} title="Overwrite the file with their version and stage it">Take theirs</button>
        <button onClick={() => root && openFile(`${root}/${path}`)} title="Edit the file with its conflict markers">Edit…</button>
        <button className="primary" onClick={() => resolve("workdir")} title="Stage the file as it is in the working tree">Mark resolved</button>
      </div>
      <div className="diff-labels"><span>{lt}</span><span>{rt}</span></div>
      <div className="diff-body">
      {c.binary ? <div className="center muted">Binary file: choose "Take ours" or "Take theirs".</div> : (
        <DiffEditor
          original={deleted(orig)}
          modified={deleted(mod)}
          language={langOf(path)}
          theme={theme === "dark" ? "vs-dark" : "vs"}
          options={{ readOnly: true, originalEditable: false, renderSideBySide: true, fontSize: 12, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false }}
        />
      )}
      </div>
    </div>
  );
}
