// Bridge between the Tauri backend (Rust kernel client) and the UI store.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addFigure, addHistory, get, pushConsole, set } from "./store";
import type { DetailWindow, KernelEvent, VarInfo } from "./types";
import { startLsp } from "./lsp";

const pending = new Map<string, { resolve: (c: any) => void; reject: (e: any) => void }>();
/** Replies that arrived before the caller registered a waiter (fast control replies). */
const early = new Map<string, any>();
const userExecs = new Set<string>();

/** Per-execution output sinks (notebook cells). Items mirror console items, plus "clear". */
export type OutputItem =
  | { kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { kind: "result"; data: Mime; count: number | null }
  | { kind: "display"; data: Mime; displayId?: string }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] }
  | { kind: "clear"; wait: boolean }
  | { kind: "count"; count: number | null };
type Mime = Record<string, unknown>;
const sinks = new Map<string, (item: OutputItem) => void>();

/** Resolve when the shell reply for `msgId` arrives. */
export function awaitReply(msgId: string, timeoutMs = 600_000): Promise<any> {
  if (early.has(msgId)) {
    const c = early.get(msgId);
    early.delete(msgId);
    return Promise.resolve(c);
  }
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(msgId)) reject(new Error("timeout waiting for kernel reply"));
    }, timeoutMs);
  });
}

function applyWorkspace(ue: any) {
  const data = ue?.ws?.data?.["application/x-pide+json"];
  if (!data?.variables) return;
  const prev = new Map(get().variables.map((v) => [v.name, v]));
  const vars: VarInfo[] = data.variables;
  const changed = new Set<string>();
  for (const v of vars) {
    const p = prev.get(v.name);
    if (!p || p.id !== v.id || p.value !== v.value || JSON.stringify(p.shape) !== JSON.stringify(v.shape)) {
      changed.add(v.name);
    }
  }
  vars.sort((a, b) => a.name.localeCompare(b.name));
  set({ variables: vars, changed });
}

function handleEvent(ev: KernelEvent) {
  const c = ev.content;
  if (ev.channel === "iopub") {
    switch (ev.msg_type) {
      case "status":
        if (c.execution_state === "busy") set({ kernel: "busy" });
        else if (c.execution_state === "idle") set({ kernel: "idle" });
        return;
      case "execute_input":
        // Only echo code we did not print ourselves (e.g. from other clients).
        return;
      case "stream": {
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "stream", name: c.name, text: c.text });
        else pushConsole({ kind: "stream", name: c.name, text: c.text });
        return;
      }
      case "execute_result": {
        set({ execCount: c.execution_count ?? get().execCount });
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "result", data: c.data, count: c.execution_count });
        else pushConsole({ kind: "result", data: c.data, count: c.execution_count });
        routeFigure(c.data, `Out[${c.execution_count}]`);
        return;
      }
      case "display_data":
      case "update_display_data": {
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "display", data: c.data, displayId: c.transient?.display_id });
        else pushConsole({ kind: "display", data: c.data, displayId: c.transient?.display_id });
        routeFigure(c.data, `Figure ${get().figures.length + 1}`);
        return;
      }
      case "error": {
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] });
        else pushConsole({ kind: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] });
        return;
      }
      case "clear_output": {
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "clear", wait: !!c.wait });
        return;
      }
      case "debug_event":
        import("./debug").then((d) => d.onDebugEvent(c));
        return;
    }
  } else if (ev.channel === "control") {
    if (!ev.parent_id) return;
    const p = pending.get(ev.parent_id);
    if (p) { pending.delete(ev.parent_id); p.resolve(c); }
    else { early.set(ev.parent_id, c); setTimeout(() => early.delete(ev.parent_id!), 60_000); }
  } else if (ev.channel === "shell") {
    if (ev.msg_type === "execute_reply") {
      applyWorkspace(c.user_expressions);
      if (c.execution_count != null) set({ execCount: c.execution_count });
      const sink = ev.parent_id && sinks.get(ev.parent_id);
      if (sink) { sink({ kind: "count", count: c.execution_count ?? null }); sinks.delete(ev.parent_id!); }
    }
    const p = ev.parent_id && pending.get(ev.parent_id);
    if (p) {
      pending.delete(ev.parent_id!);
      p.resolve(c);
    } else if (ev.parent_id && ev.msg_type.endsWith("_reply")) {
      early.set(ev.parent_id, c);
      setTimeout(() => early.delete(ev.parent_id!), 60_000);
    }
  } else if (ev.channel === "stdin" && ev.msg_type === "input_request") {
    set({ inputRequest: { parent: ev, prompt: c.prompt ?? "", password: !!c.password } });
  }
}

/** Images / plotly bundles also go to the Figures panel, MATLAB style. */
function routeFigure(data: Record<string, unknown>, title: string) {
  if (data["application/vnd.plotly.v1+json"]) {
    const b = data["application/vnd.plotly.v1+json"] as any;
    addFigure({ title, kind: "plotly", data: b.data, layout: b.layout });
  } else if (data["image/png"]) {
    addFigure({ title, kind: "png", data: data["image/png"] });
  } else if (data["image/svg+xml"]) {
    addFigure({ title, kind: "svg", data: data["image/svg+xml"] });
  }
}

let started = false;
export async function initKernelBridge() {
  if (started) return;
  started = true;
  await listen<KernelEvent>("kernel-event", (e) => handleEvent(e.payload));
  await listen<any>("kernel-status", (e) => {
    const p = e.payload;
    set({ kernel: p.state, python: p.python ?? get().python, cwd: p.cwd ?? get().cwd, kernelDetail: p.detail ?? null });
    if (p.state === "dead" && p.detail) pushConsole({ kind: "info", text: `Kernel died: ${p.detail}` });
  });
  const pythons = await invoke<string[]>("detect_pythons");
  const envPython = await invoke<string | null>("dev_env", { name: "PIDE_PYTHON" });
  if (envPython) { set({ remote: null, connectionFile: null }); localStorage.setItem("pide.remote", "null"); }
  const saved = envPython ?? localStorage.getItem("pide.python");
  set({ pythons: saved && !pythons.includes(saved) ? [saved, ...pythons] : pythons, python: saved ?? pythons[0] ?? "python3" });
  const cwdOverride = await invoke<string | null>("dev_env", { name: "PIDE_CWD" });
  if (cwdOverride) set({ cwd: cwdOverride });
  else if (!get().cwd) set({ cwd: localStorage.getItem("pide.cwd") ?? (await invoke<string>("home_dir")) });
}

let starting: Promise<void> | null = null;
export function startKernel() {
  if (!starting) starting = startKernelInner().finally(() => (starting = null));
  return starting;
}

async function startKernelInner() {
  const { python, cwd, remote, connectionFile } = get();
  set({ console: [...get().console], inputRequest: null });
  pushConsole({ kind: "info", text: remote ? `Starting remote kernel on ${remote.host}: ${remote.python}` : connectionFile ? `Connecting to kernel: ${connectionFile}` : `Starting kernel: ${python}` });
  try {
    await invoke("start_kernel", { python, cwd, remote: remote ? { host: remote.host, port: remote.port ?? null, python: remote.python, cwd: remote.cwd || null } : null, connectionFile });
    pushConsole({ kind: "info", text: "Kernel ready." });
    startLsp().catch((e) => pushConsole({ kind: "info", text: `LSP: ${e}` }));
    // Make matplotlib figures appear inline (routed to the Figures panel).
    await runSilent("try:\n import matplotlib\n matplotlib.use('module://matplotlib_inline.backend_inline')\nexcept Exception: pass");
    await refreshWorkspace();
    // Dev helper: PIDE_AUTORUN="code" executes code once the kernel is up.
    const auto = await invoke<string | null>("dev_autorun");
    if (auto && !autorunDone) {
      autorunDone = true;
      await execute(auto);
      const script = await invoke<string | null>("dev_script");
      if (script) new Function(script)();
    }
  } catch (e) {
    pushConsole({ kind: "info", text: `Failed to start kernel: ${e}` });
  }
}
let autorunDone = false;

export async function restartKernel() {
  pushConsole({ kind: "info", text: "Restarting kernel..." });
  set((s) => ({ variables: [], changed: new Set(), debug: { ...s.debug, active: false, stopped: false, frames: [], frameId: null, variables: [], cellFiles: {} } }));
  await startKernel();
}

export async function interrupt() {
  await invoke("interrupt_kernel");
}

/** Execute user code: echoes it in the console and records history. */
export async function execute(code: string, { echo = true, sink, history = true }: { echo?: boolean; sink?: (item: OutputItem) => void; history?: boolean } = {}): Promise<any> {
  if (!code.trim()) return;
  if (get().kernel === "stopped" || get().kernel === "dead") await startKernel();
  const id = crypto.randomUUID();
  if (sink) sinks.set(id, sink);
  const reply = awaitReply(id);
  await invoke<string>("execute", { code, opts: { workspace: true, include_hidden: get().showHidden, msg_id: id } }).catch((e) => { sinks.delete(id); throw e; });
  if (echo) pushConsole({ kind: "input", code, count: get().execCount + 1, msgId: id });
  if (history) addHistory(code);
  return reply;
}

export async function runSilent(code: string): Promise<any> {
  const id = await invoke<string>("execute", { code, opts: { silent: true, store_history: false, workspace: false } });
  return awaitReply(id);
}

export async function refreshWorkspace() {
  if (get().kernel !== "idle" && get().kernel !== "busy") return;
  const id = await invoke<string>("refresh_workspace", { includeHidden: get().showHidden });
  await awaitReply(id);
}

export async function fetchDetail(path: string, win: { row0: number; row1: number; col0: number; col1: number; index?: number[] }): Promise<DetailWindow> {
  const id = await invoke<string>("variable_detail", { path, win });
  const reply = await awaitReply(id);
  const ue = reply.user_expressions?.detail;
  if (ue?.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  return ue.data["application/x-pide+json"];
}

export async function fetchPlotData(path: string): Promise<any> {
  const id = await invoke<string>("plot_data", { path });
  const reply = await awaitReply(id);
  const ue = reply.user_expressions?.plot;
  if (ue?.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  return ue.data["application/x-pide+json"];
}

export interface ImageData_ { path: string; shape: number[]; dtype: string; layout: string; extra: number[]; index: number[]; h: number; w: number; channels: number; vmin: number; vmax: number; step: number; data: string; error?: string }
export async function fetchImage(path: string, opts: { index?: number[]; vmin?: number | null; vmax?: number | null; layout?: string }): Promise<ImageData_> {
  const id = await invoke<string>("variable_image", { path, opts });
  const reply = await awaitReply(id);
  const ue = reply.user_expressions?.image;
  if (ue?.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  return ue.data["application/x-pide+json"];
}

export async function fetchPlotExpr(expr: string): Promise<any> {
  const id = await invoke<string>("plot_expr", { expr });
  const reply = await awaitReply(id);
  const ue = reply.user_expressions?.plot;
  if (ue?.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  return ue.data["application/x-pide+json"];
}

export async function complete(code: string, cursor: number): Promise<{ matches: string[]; cursor_start: number; cursor_end: number }> {
  const id = await invoke<string>("complete", { code, cursor });
  return awaitReply(id, 5000);
}

export async function isComplete(code: string): Promise<"complete" | "incomplete" | "invalid" | "unknown"> {
  try {
    const id = await invoke<string>("is_complete", { code });
    const r = await awaitReply(id, 3000);
    return r.status;
  } catch {
    return "unknown";
  }
}

export async function replyInput(value: string) {
  const req = get().inputRequest;
  if (!req) return;
  set({ inputRequest: null });
  // The stdin reply must carry the kernel's request header as parent.
  await invoke("input_reply", { parent: req.parent.header, value });
}

export async function setCwd(path: string) {
  localStorage.setItem("pide.cwd", path);
  set({ cwd: path });
  if (get().kernel === "idle") await runSilent(`import os as _os; _os.chdir(${JSON.stringify(path)})`);
}

export function setPython(p: string) {
  localStorage.setItem("pide.python", p);
  set({ python: p, remote: null, connectionFile: null });
  localStorage.setItem("pide.remote", "null");
}

export function setRemote(r: { host: string; port?: number | null; python: string; cwd?: string | null } | null) {
  localStorage.setItem("pide.remote", JSON.stringify(r));
  set({ remote: r, connectionFile: null });
}

export function setConnectionFile(f: string | null) {
  set({ connectionFile: f, remote: null });
}
