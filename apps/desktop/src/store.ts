import { useSyncExternalStore } from "react";
import type { ConsoleItem, Figure, KernelState, VarInfo } from "./types";

/** Safe localStorage JSON read (corrupt values must never blank the window). */
export function readJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}

function loadBreakpoints(): Record<string, any[]> {
  const raw = readJson<Record<string, any[]>>("pide.breakpoints", {});
  const out: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v) || k.startsWith("untitled:") || k.startsWith("vscode-notebook-cell:untitled") || k.includes("/Untitled-")) continue;
    out[k] = v.map((x) => (typeof x === "number" ? { line: x } : x));
  }
  return out;
}

export interface State {
  kernel: KernelState;
  kernelDetail: string | null;
  python: string | null;
  cwd: string | null;
  /** SSH remote kernel profile, or null for local. */
  remote: { host: string; port?: number | null; python: string; cwd?: string | null } | null;
  connectionFile: string | null;
  pythons: string[];
  variables: VarInfo[];
  changed: Set<string>;
  selectedVar: string | null;
  selectedVars: string[];
  /** Expression chosen in a Variable Viewer (e.g. df[['a','b']]), used by the Plots tab. */
  plotExpr: string | null;
  showHidden: boolean;
  console: ConsoleItem[];
  history: string[];
  figures: Figure[];
  activeFigure: number | null;
  inputRequest: { parent: any; prompt: string; password: boolean } | null;
  execCount: number;
  lsp: Record<string, string>;
  tools: import("./tools").ToolSettings;
  themePref: "light" | "dark" | "system";
  theme: "light" | "dark";
  debug: import("./debug").DebugState;
  /** Breakpoint being edited in the dialog. */
  bpEdit: { uri: string; line: number } | null;
  promptReq: { message: string; value: string; placeholder: string; resolve: (v: string | null) => void } | null;
  git: { status: import("./git").GitStatus | null; log: import("./git").Commit[]; error: string | null };
}

let state: State = {
  kernel: "stopped",
  kernelDetail: null,
  python: null,
  cwd: null,
  remote: readJson("pide.remote", null),
  connectionFile: null,
  pythons: [],
  variables: [],
  changed: new Set(),
  selectedVar: null,
  selectedVars: [],
  plotExpr: null,
  showHidden: false,
  console: [],
  history: readJson<string[]>("pide.history", []),
  figures: [],
  activeFigure: null,
  inputRequest: null,
  execCount: 0,
  lsp: {},
  tools: { linter: "ruff", formatter: "ruff", linterArgs: "", formatterArgs: "", lineLength: 88, ...readJson("pide.tools", {}) },
  themePref: "system",
  theme: "light",
  git: { status: null, log: [], error: null },
  bpEdit: null,
  promptReq: null,
  debug: { active: false, stopped: false, threadId: null, reason: null, frames: [], frameId: null, breakpoints: loadBreakpoints(), exceptions: readJson("pide.exceptions", { uncaught: true, raised: false }), exceptionInfo: null, cellFiles: {}, scopes: [], variables: [] },
};

const listeners = new Set<() => void>();

export function get(): State {
  return state;
}

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
  );
}

/** Panels with unsaved changes: panel id → title. Kept outside dockview params (those do not round-trip). */
export const dirtyPanels = new Map<string, string>();
export function setDirtyPanel(id: string, title: string, dirty: boolean) {
  if (dirty) dirtyPanels.set(id, title); else dirtyPanels.delete(id);
}

let nextId = 1;
export function uid() {
  return nextId++;
}

const MAX_CONSOLE = 5000;
/** A single stream item never grows past this; a new item is started instead (keeps re-render cost bounded). */
const MAX_STREAM_ITEM = 64 * 1024;
/** Total retained stream text; oldest items are dropped beyond it. */
const MAX_CONSOLE_BYTES = 8 * 1024 * 1024;
/**
 * Append stream text with terminal semantics: a lone `\r` returns to the start of the current line
 * (progress bars), `\r\n` is a newline. A `\r` ending the chunk is kept until the next chunk shows
 * whether a `\n` follows. Only the last line of `base` is ever touched.
 */
export function appendStreamText(base: string, text: string): string {
  if (!text) return base;
  const lineStart = (t: string) => t.lastIndexOf("\n") + 1;
  let out = base;
  if (out.endsWith("\r")) out = text[0] === "\n" ? out.slice(0, -1) : out.slice(0, lineStart(out));
  if (text.indexOf("\r") < 0) return out + text;
  let i = 0;
  while (i < text.length) {
    const cr = text.indexOf("\r", i);
    if (cr < 0) { out += text.slice(i); break; }
    out += text.slice(i, cr);
    if (cr === text.length - 1) out += "\r";
    else if (text[cr + 1] !== "\n") out = out.slice(0, lineStart(out));
    i = cr + 1;
  }
  return out;
}
/** Display form of stream text (drops a pending trailing `\r`). */
export const streamDisplay = (t: string) => (t.endsWith("\r") ? t.slice(0, -1) : t);

type NewItem = ConsoleItem extends infer T ? (T extends ConsoleItem ? Omit<T, "id"> : never) : never;
export function pushConsole(item: NewItem) {
  set((s) => {
    const list = s.console;
    let next: ConsoleItem[];
    const last = list[list.length - 1];
    if (item.kind === "stream" && last && last.kind === "stream" && last.name === item.name && last.text.length + item.text.length <= MAX_STREAM_ITEM) {
      next = [...list.slice(0, -1), { ...last, text: appendStreamText(last.text, item.text) }];
    } else {
      next = [...list, { ...item, ...(item.kind === "stream" ? { text: appendStreamText("", item.text) } : {}), id: uid() } as ConsoleItem];
    }
    if (next.length > MAX_CONSOLE) next = next.slice(next.length - MAX_CONSOLE);
    let bytes = 0;
    for (let i = next.length - 1; i >= 0; i--) {
      const it = next[i];
      bytes += it.kind === "stream" ? it.text.length : it.kind === "error" ? it.traceback.join("").length : 200;
      if (bytes > MAX_CONSOLE_BYTES) { next = next.slice(i + 1); break; }
    }
    return { console: next };
  });
}

const MAX_FIGURES = 60;
export function addFigure(f: Omit<Figure, "id">) {
  const id = uid();
  set((s) => { const figs = [...s.figures, { ...f, id }]; return { figures: figs.length > MAX_FIGURES ? figs.slice(figs.length - MAX_FIGURES) : figs, activeFigure: id }; });
  return id;
}

export function addHistory(code: string) {
  set((s) => {
    const h = [...s.history.filter((x) => x !== code), code].slice(-500);
    localStorage.setItem("pide.history", JSON.stringify(h));
    return { history: h };
  });
}
