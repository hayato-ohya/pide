// Debugger client: DAP over Jupyter's debug_request (ipykernel + debugpy).
import { invoke } from "@tauri-apps/api/core";
import { awaitReply, execute, runSilent } from "./kernel";
import { get, pushConsole, set } from "./store";
import * as monaco from "monaco-editor";

/** Editor URI (file:///...) → filesystem path for debugpy; untitled buffers have none. */
export function uriToPath(uri: string): string | null {
  if (uri.startsWith("file://")) return monaco.Uri.parse(uri).fsPath;
  if (uri.startsWith("untitled:")) return null;
  return uri;
}
export function pathToUri(path: string): string {
  return monaco.Uri.file(path).toString();
}

export interface Frame { id: number; name: string; path: string | null; line: number; column: number }
export interface DapVar { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string }
export interface DebugState {
  active: boolean;
  stopped: boolean;
  threadId: number | null;
  reason: string | null;
  frames: Frame[];
  frameId: number | null;
  /** editor path → sorted 1-based lines */
  breakpoints: Record<string, number[]>;
  /** DAP temp file (dumpCell) → { uri, startLine } so stops map back to the editor */
  cellFiles: Record<string, { uri: string; path: string | null; startLine: number }>;
  scopes: { name: string; variablesReference: number }[];
  variables: DapVar[];
}
export const initialDebug: DebugState = { active: false, stopped: false, threadId: null, reason: null, frames: [], frameId: null, breakpoints: JSON.parse(localStorage.getItem("pide.breakpoints") ?? "{}"), cellFiles: {}, scopes: [], variables: [] };

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
export async function startDebugger() {
  if (get().debug.active) return;
  if (get().kernel === "stopped" || get().kernel === "dead") { const k = await import("./kernel"); await k.startKernel(); }
  try {
    await dap("initialize", { clientID: "pide", clientName: "Pide", adapterID: "python", pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false, locale: "en" });
    await dap("attach", {});
    for (const [path, lines] of Object.entries(get().debug.breakpoints)) if (lines.length && !path.startsWith("untitled:")) await pushBreakpoints(path, lines);
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
  patch({ active: false, stopped: false, frames: [], frameId: null, variables: [], scopes: [], cellFiles: {} });
}

async function pushBreakpoints(pathOrUri: string, lines: number[]) {
  const path = pathOrUri.startsWith("/") || /^[A-Za-z]:\\/.test(pathOrUri) ? pathOrUri : uriToPath(pathOrUri);
  if (!path) return;
  return dap("setBreakpoints", { source: { path }, breakpoints: lines.map((line) => ({ line })), sourceModified: false });
}

export function toggleBreakpoint(editorPath: string, line: number) {
  const bp = { ...get().debug.breakpoints };
  const lines = new Set(bp[editorPath] ?? []);
  if (lines.has(line)) lines.delete(line); else lines.add(line);
  bp[editorPath] = [...lines].sort((a, b) => a - b);
  if (!bp[editorPath].length) delete bp[editorPath];
  patch({ breakpoints: bp });
  localStorage.setItem("pide.breakpoints", JSON.stringify(bp));
  if (get().debug.active && !editorPath.startsWith("untitled:")) pushBreakpoints(editorPath, bp[editorPath] ?? []).catch((e) => pushConsole({ kind: "info", text: `breakpoints: ${e}` }));
}

export function clearBreakpoints() {
  for (const p of Object.keys(get().debug.breakpoints)) if (get().debug.active && !p.startsWith("untitled:")) pushBreakpoints(p, []).catch(() => {});
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
export async function debugCell(code: string, editorPath: string, startLine: number) {
  await startDebugger();
  if (!get().debug.active) return;
  const { sourcePath } = await dap("dumpCell", { code });
  const lines = (get().debug.breakpoints[editorPath] ?? []).filter((l) => l >= startLine && l < startLine + code.split("\n").length).map((l) => l - startLine + 1);
  patch({ cellFiles: { ...get().debug.cellFiles, [sourcePath]: { uri: editorPath, path: editorPath.startsWith("untitled:") ? null : editorPath, startLine } } });
  await pushBreakpoints(sourcePath, lines);
  await execute(code);
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
  if (cell) return `${(cell.path ?? cell.uri).split("/").pop()} (cell):${line + cell.startLine - 1}`;
  return `${path.split("/").pop()}:${line}`;
}

export async function selectFrame(frameId: number) {
  patch({ frameId });
  try {
    const { scopes } = await dap("scopes", { frameId });
    const locals = scopes.find((s: any) => /local/i.test(s.name)) ?? scopes[0];
    const vars = locals ? await fetchVariables(locals.variablesReference) : [];
    patch({ scopes, variables: vars });
  } catch (e) {
    pushConsole({ kind: "info", text: `scopes: ${e}` });
  }
}

export async function fetchVariables(ref: number): Promise<DapVar[]> {
  const { variables } = await dap("variables", { variablesReference: ref });
  return (variables as DapVar[]).filter((v) => !["special variables", "function variables", "class variables"].includes(v.name));
}

/** Called from the kernel bridge for every iopub debug_event. */
export async function onDebugEvent(ev: { event: string; body: any }) {
  const d = get().debug;
  switch (ev.event) {
    case "stopped": {
      const threadId = ev.body.threadId ?? d.threadId ?? 1;
      try {
        const { stackFrames } = await dap("stackTrace", { threadId });
        const frames: Frame[] = (stackFrames as any[]).map((f) => ({ id: f.id, name: f.name, path: f.source?.path ?? null, line: f.line, column: f.column }));
        patch({ stopped: true, threadId, reason: ev.body.reason, frames });
        if (frames[0]) {
          await selectFrame(frames[0].id);
          const m = editorPathFor(frames[0].path);
          if (m) import("./layout").then((l) => l.revealInEditor(m.uri, m.line(frames[0].line)));
        }
      } catch (e) {
        pushConsole({ kind: "info", text: `stackTrace: ${e}` });
      }
      return;
    }
    case "continued":
      patch({ stopped: false, frames: [], frameId: null, variables: [] });
      return;
    case "terminated":
    case "exited":
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
