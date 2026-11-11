// Debugger client: DAP over Jupyter's debug_request (ipykernel + debugpy).
import { invoke } from "@tauri-apps/api/core";
import { awaitReply, execute, runSilent } from "./kernel";
import { get, pushConsole, set } from "./store";
import * as monaco from "monaco-editor";

/** Editor URI (file:///...) → filesystem path for debugpy; untitled buffers have none. */
export function uriToPath(uri: string): string | null {
  if (uri.startsWith("file://")) return monaco.Uri.parse(uri).fsPath;
  if (uri.startsWith("untitled:") || uri.startsWith("vscode-notebook-cell:")) return null;
  return uri;
}
export function pathToUri(path: string): string {
  return monaco.Uri.file(path).toString();
}

export interface Breakpoint {
  line: number;
  /** Python expression; stop only when truthy. */
  condition?: string;
  /** e.g. ">= 3" or "5": stop on the Nth hit. */
  hitCondition?: string;
  /** Logpoint: print this (with {expr} interpolation) instead of stopping. */
  logMessage?: string;
}

export const bpLines = (bps: Breakpoint[] | undefined) => (bps ?? []).map((b) => b.line);

export interface Frame { id: number; name: string; path: string | null; line: number; column: number }
export interface DapVar { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string }
export interface DebugState {
  active: boolean;
  stopped: boolean;
  threadId: number | null;
  reason: string | null;
  frames: Frame[];
  frameId: number | null;
  /** editor path → breakpoints sorted by line */
  breakpoints: Record<string, Breakpoint[]>;
  /** Exception filters sent to debugpy. */
  exceptions: { uncaught: boolean; raised: boolean };
  /** Details when stopped on an exception. */
  exceptionInfo: { id: string; description: string; details?: string } | null;
  /** DAP temp file (dumpCell) → { uri, startLine } so stops map back to the editor */
  cellFiles: Record<string, { uri: string; path: string | null; startLine: number; lineCount: number }>;
  scopes: { name: string; variablesReference: number }[];
  variables: DapVar[];
}

let seq = 0;
function patch(p: Partial<DebugState>) {
  set((s) => ({ debug: { ...s.debug, ...p } }));
}

export async function dap(command: string, args: Record<string, unknown> = {}): Promise<any> {
  const id = await invoke<string>("debug_request", { content: { type: "request", seq: ++seq, command, arguments: args } });
  const reply = await awaitReply(id, 30000);
  if (reply && reply.success === false) throw new Error(reply.message ?? `${command} failed`);
  return reply?.body ?? {};
}

/** Start debugpy inside the kernel and push all known breakpoints. */
let starting: Promise<void> | null = null;
export function startDebugger(): Promise<void> {
  if (get().debug.active) return Promise.resolve();
  // Shared in-flight start: a double click must not send initialize / attach twice.
  if (!starting) starting = startDebuggerInner().finally(() => (starting = null));
  return starting;
}

async function startDebuggerInner() {
  if (get().kernel === "stopped" || get().kernel === "dead") { const k = await import("./kernel"); await k.startKernel(); }
  try {
    await dap("initialize", { clientID: "pide", clientName: "Pide", adapterID: "python", pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false, locale: "en" });
    await dap("attach", {});
    for (const [path, bps] of Object.entries(get().debug.breakpoints)) if (bps.length && !path.startsWith("untitled:") && !path.startsWith("vscode-notebook-cell:")) await pushBreakpoints(path, bps);
    await pushExceptionFilters();
    await dap("configurationDone");
    patch({ active: true });
    pushConsole({ kind: "info", text: "Debugger attached." });
  } catch (e) {
    pushConsole({ kind: "info", text: `Debugger failed to start (is debugpy installed in this environment?): ${e}` });
  }
}

export async function stopDebugger() {
  if (!get().debug.active) return;
  try {
    if (get().debug.stopped && get().debug.threadId != null) await dap("continue", { threadId: get().debug.threadId }).catch(() => {});
    await dap("disconnect", { restart: false, terminateDebuggee: false });
  } catch { /* kernel may be gone */ }
  patch({ active: false, stopped: false, frames: [], frameId: null, variables: [], scopes: [], cellFiles: {}, exceptionInfo: null });
}

async function pushBreakpoints(pathOrUri: string, bps: Breakpoint[]) {
  const path = pathOrUri.startsWith("/") || /^[A-Za-z]:\\/.test(pathOrUri) ? pathOrUri : uriToPath(pathOrUri);
  if (!path) return;
  return dap("setBreakpoints", { source: { path }, breakpoints: bps.map((b) => ({ line: b.line, condition: b.condition || undefined, hitCondition: b.hitCondition || undefined, logMessage: b.logMessage || undefined })), sourceModified: false });
}

async function pushExceptionFilters() {
  const ex = get().debug.exceptions;
  // Inside ipykernel every exception is eventually caught by the kernel, so
  // debugpy's "uncaught" never fires; "userUnhandled" is the notebook equivalent.
  const filters = [...(ex.raised ? ["raised"] : []), ...(ex.uncaught ? ["userUnhandled"] : [])];
  await dap("setExceptionBreakpoints", { filters }).catch((e) => pushConsole({ kind: "info", text: `exception breakpoints: ${e}` }));
}

export function setExceptionFilters(ex: { uncaught: boolean; raised: boolean }) {
  patch({ exceptions: ex });
  localStorage.setItem("pide.exceptions", JSON.stringify(ex));
  if (get().debug.active) pushExceptionFilters();
}

/** Breakpoints of an editor buffer that fall inside a dumped cell, in the cell file's own line numbers. */
function cellBreakpoints(editorPath: string, startLine: number, lineCount: number): Breakpoint[] {
  return (get().debug.breakpoints[editorPath] ?? []).filter((b) => b.line >= startLine && b.line < startLine + lineCount).map((b) => ({ ...b, line: b.line - startLine + 1 }));
}
/** Keep breakpoints of cells currently tracked as debugpy temp files in sync with the editor. */
function pushCellBreakpoints(editorPath: string) {
  for (const [file, c] of Object.entries(get().debug.cellFiles)) {
    if (c.uri === editorPath) pushBreakpoints(file, cellBreakpoints(editorPath, c.startLine, c.lineCount)).catch((e) => pushConsole({ kind: "info", text: `breakpoints: ${e}` }));
  }
}

function saveBreakpoints(editorPath: string, list: Breakpoint[]) {
  const bp = { ...get().debug.breakpoints };
  if (list.length) bp[editorPath] = [...list].sort((a, b) => a.line - b.line); else delete bp[editorPath];
  patch({ breakpoints: bp });
  const persist = Object.fromEntries(Object.entries(bp).filter(([k]) => !k.startsWith("untitled:") && !k.includes("/Untitled-")));
  localStorage.setItem("pide.breakpoints", JSON.stringify(persist));
  if (!get().debug.active) return;
  if (!editorPath.startsWith("untitled:") && !editorPath.startsWith("vscode-notebook-cell:")) pushBreakpoints(editorPath, bp[editorPath] ?? []).catch((e) => pushConsole({ kind: "info", text: `breakpoints: ${e}` }));
  pushCellBreakpoints(editorPath);
}

/** Follow edits: `lines[i]` is the tracked (decoration) line of the i-th stored breakpoint. */
export function syncBreakpointLines(editorPath: string, lines: number[]) {
  const list = get().debug.breakpoints[editorPath];
  if (!list || list.length !== lines.length || list.every((b, i) => b.line === lines[i])) return;
  const seen = new Set<number>();
  const next: Breakpoint[] = [];
  list.forEach((b, i) => { if (!seen.has(lines[i])) { seen.add(lines[i]); next.push({ ...b, line: lines[i] }); } });
  saveBreakpoints(editorPath, next);
}

export function toggleBreakpoint(editorPath: string, line: number) {
  const list = get().debug.breakpoints[editorPath] ?? [];
  saveBreakpoints(editorPath, list.some((b) => b.line === line) ? list.filter((b) => b.line !== line) : [...list, { line }]);
}

/** Create or update a breakpoint with condition / hit count / log message. */
export function setBreakpoint(editorPath: string, line: number, props: Omit<Breakpoint, "line">) {
  const list = get().debug.breakpoints[editorPath] ?? [];
  const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v && String(v).trim())) as Omit<Breakpoint, "line">;
  saveBreakpoints(editorPath, [...list.filter((b) => b.line !== line), { line, ...clean }]);
}

export function getBreakpoint(editorPath: string, line: number): Breakpoint | undefined {
  return get().debug.breakpoints[editorPath]?.find((b) => b.line === line);
}

export function clearBreakpoints() {
  for (const p of Object.keys(get().debug.breakpoints)) if (get().debug.active && !p.startsWith("untitled:") && !p.startsWith("vscode-notebook-cell:")) pushBreakpoints(p, []).catch(() => {});
  if (get().debug.active) for (const f of Object.keys(get().debug.cellFiles)) pushBreakpoints(f, []).catch(() => {});
  patch({ breakpoints: {} });
  localStorage.setItem("pide.breakpoints", "{}");
}

/** Run a saved file under the debugger (breakpoints in that file and any imported file). */
export async function debugFile(path: string) {
  await startDebugger();
  if (!get().debug.active) return;
  pushConsole({ kind: "info", text: `Debug ${path.split("/").pop()}` });
  await execute(`__import__('pide_kernel').run_file(${JSON.stringify(path)})`, { echo: false });
}

/** Run a cell / selection under the debugger: dumpCell gives the temp path debugpy will see. */
export async function debugCell(code: string, editorPath: string, startLine: number, sink?: (item: import("./kernel").OutputItem) => void) {
  await startDebugger();
  if (!get().debug.active) return;
  try {
    const { sourcePath } = await dap("dumpCell", { code });
    const lineCount = code.split("\n").length;
    patch({ cellFiles: { ...get().debug.cellFiles, [sourcePath]: { uri: editorPath, path: uriToPath(editorPath), startLine, lineCount } } });
    await pushBreakpoints(sourcePath, cellBreakpoints(editorPath, startLine, lineCount));
  } catch (e) {
    pushConsole({ kind: "info", text: `Debug cell: ${e}` });
    return;
  }
  await execute(code, sink ? { echo: false, history: false, sink } : {});
}

export const cont = () => get().debug.threadId != null && dap("continue", { threadId: get().debug.threadId }).catch(() => {});
export const stepOver = () => get().debug.threadId != null && dap("next", { threadId: get().debug.threadId }).catch(() => {});
export const stepIn = () => get().debug.threadId != null && dap("stepIn", { threadId: get().debug.threadId }).catch(() => {});
export const stepOut = () => get().debug.threadId != null && dap("stepOut", { threadId: get().debug.threadId }).catch(() => {});

/** Map a debugger source path back to an editor path (cell temp files → editor). */
export function editorPathFor(path: string | null): { uri: string; line: (l: number) => number } | null {
  if (!path) return null;
  const cell = get().debug.cellFiles[path];
  if (cell) return { uri: cell.uri, line: (l) => l + cell.startLine - 1 };
  return { uri: pathToUri(path), line: (l) => l };
}

/** Human label for a frame's source: cell temp files show as the editor file + "(cell)". */
export function frameLabel(path: string | null, line: number): string {
  if (!path) return `?:${line}`;
  const cell = get().debug.cellFiles[path];
  if (cell) {
    if (cell.uri.startsWith("vscode-notebook-cell:")) return `${decodeURIComponent(new URL(cell.uri).pathname).split("/").pop()} cell:${line}`;
    return `${(cell.path ?? cell.uri).split(/[\\/]/).pop()} (cell):${line + cell.startLine - 1}`;
  }
  return `${path.split(/[\\/]/).pop()}:${line}`;
}

export async function selectFrame(frameId: number) {
  const gen = stopGen;
  patch({ frameId });
  try {
    const { scopes } = await dap("scopes", { frameId });
    const locals = scopes.find((s: any) => /local/i.test(s.name)) ?? scopes[0];
    const vars = locals ? await fetchVariables(locals.variablesReference) : [];
    if (gen !== stopGen || get().debug.frameId !== frameId) return; // resumed or another frame chosen meanwhile
    patch({ scopes, variables: vars });
  } catch (e) {
    pushConsole({ kind: "info", text: `scopes: ${e}` });
  }
}

export async function fetchVariables(ref: number): Promise<DapVar[]> {
  const { variables } = await dap("variables", { variablesReference: ref });
  return (variables as DapVar[]).filter((v) => !["special variables", "function variables", "class variables"].includes(v.name));
}

/** Bumped on every stop / resume: async work for an older stop discards its results. */
let stopGen = 0;
const stale = (gen: number) => gen !== stopGen || !get().debug.active;

/** Called from the kernel bridge for every iopub debug_event. */
export async function onDebugEvent(ev: { event: string; body: any }) {
  const d = get().debug;
  switch (ev.event) {
    case "stopped": {
      const gen = ++stopGen;
      const threadId = ev.body.threadId ?? d.threadId ?? 1;
      try {
        const { stackFrames } = await dap("stackTrace", { threadId });
        if (stale(gen)) return;
        const frames: Frame[] = (stackFrames as any[]).map((f) => ({ id: f.id, name: f.name, path: f.source?.path ?? null, line: f.line, column: f.column }));
        let exceptionInfo: DebugState["exceptionInfo"] = null;
        if (ev.body.reason === "exception") {
          const info = await dap("exceptionInfo", { threadId }).catch(() => null);
          if (info) exceptionInfo = { id: (info.details?.typeName ?? info.exceptionId ?? "Exception").split(" ")[0], description: info.description ?? "", details: info.details?.stackTrace };
          if (stale(gen)) return;
          pushConsole({ kind: "info", text: `Stopped on exception: ${exceptionInfo?.id ?? ""} ${exceptionInfo?.description ?? ""}`.trim() });
        }
        patch({ stopped: true, threadId, reason: ev.body.reason, frames, exceptionInfo });
        if (frames[0]) {
          await selectFrame(frames[0].id);
          if (stale(gen)) return;
          const m = editorPathFor(frames[0].path);
          if (m) import("./layout").then((l) => l.revealInEditor(m.uri, m.line(frames[0].line)));
        }
      } catch (e) {
        if (!stale(gen)) pushConsole({ kind: "info", text: `stackTrace: ${e}` });
      }
      return;
    }
    case "output": {
      // Logpoints and debugpy messages arrive here, not on stdout.
      const cat = ev.body?.category ?? "stdout";
      if (cat === "telemetry" || !ev.body?.output) return;
      pushConsole({ kind: "stream", name: cat === "stderr" ? "stderr" : "stdout", text: ev.body.output });
      return;
    }
    case "continued":
      stopGen++;
      patch({ stopped: false, threadId: null, frames: [], frameId: null, variables: [], exceptionInfo: null });
      return;
    case "terminated":
    case "exited":
      stopGen++;
      patch({ active: false, stopped: false, frames: [], frameId: null, variables: [] });
      return;
  }
}

/** Copy a debug variable into the kernel namespace so the Workspace / viewers can use it. */
export async function copyToGlobals(name: string, frameId: number) {
  await dap("copyToGlobals", { srcVariableName: name, dstVariableName: name, srcFrameId: frameId }).catch(async () => {
    await runSilent(`pass`);
  });
}
