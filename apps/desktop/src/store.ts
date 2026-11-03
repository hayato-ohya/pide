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

let nextId = 1;
export function uid() {
  return nextId++;
}

const MAX_CONSOLE = 5000;
type NewItem = ConsoleItem extends infer T ? (T extends ConsoleItem ? Omit<T, "id"> : never) : never;
export function pushConsole(item: NewItem) {
  set((s) => {
    const list = s.console;
    // Merge consecutive stream chunks of the same stream to keep the list small.
    if (item.kind === "stream") {
      const last = list[list.length - 1];
      if (last && last.kind === "stream" && last.name === item.name) {
        const merged = { ...last, text: last.text + item.text };
        return { console: [...list.slice(0, -1), merged] };
      }
    }
    const next = [...list, { ...item, id: uid() } as ConsoleItem];
    return { console: next.length > MAX_CONSOLE ? next.slice(next.length - MAX_CONSOLE) : next };
  });
}

export function addFigure(f: Omit<Figure, "id">) {
  const id = uid();
  set((s) => ({ figures: [...s.figures, { ...f, id }], activeFigure: id }));
  return id;
}

export function addHistory(code: string) {
  set((s) => {
    const h = [...s.history.filter((x) => x !== code), code].slice(-500);
    localStorage.setItem("pide.history", JSON.stringify(h));
    return { history: h };
  });
}
