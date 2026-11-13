// Linter / formatter selection. ruff speaks LSP (handled in lsp.ts); the
// others are CLI tools run through the Tauri `run_tool` command on stdin.
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { get, pushConsole, readJson, set } from "./store";

export type Linter = "ruff" | "flake8" | "pylint" | "none";
export type Formatter = "ruff" | "black" | "autopep8" | "none";
export interface ToolSettings { linter: Linter; formatter: Formatter; linterArgs: string; formatterArgs: string; lineLength: number }

const DEFAULTS: ToolSettings = { linter: "ruff", formatter: "ruff", linterArgs: "", formatterArgs: "", lineLength: 88 };
export function loadToolSettings(): ToolSettings {
  return { ...DEFAULTS, ...readJson("pide.tools", {}) };
}
export function saveToolSettings(t: ToolSettings) {
  localStorage.setItem("pide.tools", JSON.stringify(t));
  set({ tools: t });
}
export const toolSettings = () => get().tools;

interface ToolResult { found: boolean; code: number | null; stdout: string; stderr: string }
/** Split on whitespace, keeping quoted parts together: `--ignore "E501, W503"`. */
const splitArgs = (s: string) => (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((a) => a.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, q) => d ?? q));
const warnedMissing = new Set<string>();

async function run(tool: string, args: string[], stdin: string): Promise<ToolResult | null> {
  const r = await invoke<ToolResult>("run_tool", { python: get().python ?? "python3", tool, args, stdin, cwd: get().remote || get().connectionFile ? null : get().cwd });
  if (!r.found) {
    if (!warnedMissing.has(tool)) { warnedMissing.add(tool); pushConsole({ kind: "info", text: `${tool} not found in ${get().python}. Install it with: pip install ${tool}` }); }
    return null;
  }
  return r;
}

// ---------------------------------------------------------------- format --

/** Format with the selected CLI formatter; returns null if unchanged/unavailable. */
export async function formatWithTool(text: string, displayName: string): Promise<string | null> {
  const t = toolSettings();
  const extra = splitArgs(t.formatterArgs);
  let r: ToolResult | null = null;
  if (t.formatter === "black") r = await run("black", ["-q", "--line-length", String(t.lineLength), "--stdin-filename", displayName, ...extra, "-"], text);
  else if (t.formatter === "autopep8") r = await run("autopep8", ["--max-line-length", String(t.lineLength), ...extra, "-"], text);
  else return null;
  if (!r) return null;
  if (r.code !== 0) { pushConsole({ kind: "info", text: `${t.formatter}: ${r.stderr.trim() || `exit ${r.code}`}` }); return null; }
  return r.stdout === text ? null : r.stdout;
}

// ------------------------------------------------------------------ lint --

export interface LintItem { line: number; col: number; endLine?: number; endCol?: number; code: string; message: string; severity: "error" | "warning" | "info" }

export async function lintWithTool(text: string, displayName: string): Promise<LintItem[] | null> {
  const t = toolSettings();
  const extra = splitArgs(t.linterArgs);
  if (t.linter === "flake8") {
    const r = await run("flake8", ["--max-line-length", String(t.lineLength), "--format=%(row)d:%(col)d:%(code)s:%(text)s", "--stdin-display-name", displayName, ...extra, "-"], text);
    if (!r) return null;
    return r.stdout.split("\n").filter(Boolean).map((l) => {
      const m = /^(\d+):(\d+):([A-Z]+\d*):(.*)$/.exec(l);
      if (!m) return null;
      const code = m[3];
      return { line: +m[1], col: +m[2], code, message: m[4].trim(), severity: code.startsWith("E9") || code.startsWith("F") ? "error" : code.startsWith("W") || code.startsWith("C") ? "info" : "warning" } as LintItem;
    }).filter((x): x is LintItem => !!x);
  }
  if (t.linter === "pylint") {
    const r = await run("pylint", ["--from-stdin", displayName, "--output-format=json", "--max-line-length", String(t.lineLength), ...extra], text);
    if (!r) return null;
    try {
      const items = JSON.parse(r.stdout || "[]") as any[];
      return items.map((it) => ({ line: it.line, col: (it.column ?? 0) + 1, endLine: it.endLine ?? undefined, endCol: it.endColumn != null ? it.endColumn + 1 : undefined, code: `${it["message-id"]} (${it.symbol})`, message: it.message, severity: it.type === "error" || it.type === "fatal" ? "error" : it.type === "warning" ? "warning" : "info" }));
    } catch { pushConsole({ kind: "info", text: `pylint: ${r.stderr.trim().slice(0, 300)}` }); return null; }
  }
  return null;
}

/** Push CLI lint results onto a Monaco model as markers (owner "linter"). */
export function applyLint(monaco: typeof Monaco, model: Monaco.editor.ITextModel, items: LintItem[] | null) {
  if (!items) { monaco.editor.setModelMarkers(model, "linter", []); return; }
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
  monaco.editor.setModelMarkers(model, "linter", items.map((it) => {
    const line = Math.max(1, Math.min(model.getLineCount(), it.line));
    const endLine = it.endLine ? Math.max(1, Math.min(model.getLineCount(), it.endLine)) : line;
    const word = model.getWordAtPosition({ lineNumber: line, column: Math.max(1, it.col) });
    return { severity: sev[it.severity], message: it.message, code: it.code, source: toolSettings().linter, startLineNumber: line, startColumn: Math.max(1, it.col), endLineNumber: endLine, endColumn: it.endCol ?? (word ? word.endColumn : model.getLineMaxColumn(line)) };
  }));
}

/** Debounced per-model linting for the CLI linters. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Latest lint run per model: a slow earlier run must not overwrite a newer one's markers. */
const lintRuns = new Map<string, number>();
export function scheduleLint(monaco: typeof Monaco, model: Monaco.editor.ITextModel, displayName: string) {
  const key = model.uri.toString();
  const t = toolSettings();
  if (t.linter === "ruff" || t.linter === "none") { applyLint(monaco, model, null); return; }
  if (timers.has(key)) clearTimeout(timers.get(key)!);
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    if (model.isDisposed()) { lintRuns.delete(key); return; } // tab closed within the debounce
    const run = (lintRuns.get(key) ?? 0) + 1;
    lintRuns.set(key, run);
    const items = await lintWithTool(model.getValue(), displayName).catch(() => null);
    if (!model.isDisposed() && lintRuns.get(key) === run) applyLint(monaco, model, items);
  }, 600));
}
