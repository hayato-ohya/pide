import { useEffect, useMemo, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { IDockviewPanelProps } from "dockview";
import type { FileDiff } from "../git";
import { useStore } from "../store";

function langOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ py: "python", json: "json", ipynb: "json", md: "markdown", toml: "ini", yaml: "yaml", yml: "yaml", js: "javascript", ts: "typescript", rs: "rust", html: "html", css: "css", sh: "shell", txt: "plaintext" } as Record<string, string>)[ext ?? ""] ?? "plaintext";
}

// ---------------------------------------------------------- notebook diff --

interface Cell { id?: string; cell_type: string; source: string; execution_count?: number | null; nOutputs: number }
function parseNb(text: string | null): Cell[] {
  if (!text) return [];
  try {
    const nb = JSON.parse(text);
    return (nb.cells ?? []).map((c: any) => ({ id: c.id, cell_type: c.cell_type, source: Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""), execution_count: c.execution_count, nOutputs: (c.outputs ?? []).length }));
  } catch { return []; }
}

/** Align cells by id when present, else by LCS on source text. */
function alignCells(a: Cell[], b: Cell[]): [Cell | null, Cell | null][] {
  const key = (c: Cell) => c.id ?? c.source;
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [Cell | null, Cell | null][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) { out.push([a[i++], b[j++]]); }
    else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // Heuristic: pair a removed+added cell as "modified" when both are the same type.
      if (dp[i + 1][j] === dp[i][j + 1] && a[i].cell_type === b[j].cell_type) out.push([a[i++], b[j++]]);
      else out.push([a[i++], null]);
    } else out.push([null, b[j++]]);
  }
  while (i < n) out.push([a[i++], null]);
  while (j < m) out.push([null, b[j++]]);
  return out;
}

function NotebookDiff({ d }: { d: FileDiff }) {
  const theme = useStore((s) => s.theme);
  const pairs = useMemo(() => alignCells(parseNb(d.old), parseNb(d.new)), [d]);
  return (
    <div className="nbdiff">
      {pairs.map(([a, b], i) => {
        const kind = !a ? "added" : !b ? "removed" : a.source === b.source ? "same" : "changed";
        const cell = (b ?? a)!;
        const outNote = a && b && a.nOutputs !== b.nOutputs ? ` · outputs ${a.nOutputs}→${b.nOutputs}` : "";
        return (
          <div key={i} className={`nbcell ${kind}`}>
            <div className="nbcell-h"><span className="tag">{cell.cell_type}</span> <span className="muted">{kind}{outNote}</span></div>
            {kind === "changed" ? (
              <div style={{ height: Math.min(400, 20 * Math.max(a!.source.split("\n").length, b!.source.split("\n").length) + 20) }}>
                <DiffEditor original={a!.source} modified={b!.source} language={cell.cell_type === "code" ? "python" : "markdown"} theme={theme === "dark" ? "vs-dark" : "vs"}
                  options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: "off", fontSize: 12, renderOverviewRuler: false }} />
              </div>
            ) : (
              <pre className="nbcell-src">{cell.source}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ panel --

export default function DiffView(props: IDockviewPanelProps<{ diff: FileDiff; label: string }>) {
  const d = props.params.diff;
  const theme = useStore((s) => s.theme);
  const isNb = d.path.endsWith(".ipynb");
  const [sideBySide, setSide] = [useRef(true), (v: boolean) => (sideBySide.current = v)];
  useEffect(() => { props.api.setTitle(`${d.path.split("/").pop()} (${props.params.label})`); }, []);
  if (d.binary) return <div className="center muted">Binary file</div>;
  return (
    <div className="diffview">
      <div className="panel-toolbar">
        <span className="vv-title">{d.old_path ? `${d.old_path} → ` : ""}{d.path}</span>
        <span className="muted">{d.code === "A" ? "added" : d.code === "D" ? "deleted" : d.code === "R" ? "renamed" : "modified"} · +{d.additions} −{d.deletions} · {props.params.label}</span>
        {isNb && <span className="muted">cell diff (outputs ignored)</span>}
      </div>
      <div className="diff-body">
        {isNb ? <NotebookDiff d={d} /> : (
          <DiffEditor original={d.old ?? ""} modified={d.new ?? ""} language={langOf(d.path)} theme={theme === "dark" ? "vs-dark" : "vs"}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12.5, automaticLayout: true }} />
        )}
      </div>
    </div>
  );
}
