// Bridge between the Tauri backend (Rust kernel client) and the UI store.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addFigure, addHistory, get, pushConsole, set } from "./store";
import type { DetailWindow, Figure, KernelEvent, VarInfo } from "./types";
import { startLsp } from "./lsp";

const pending = new Map<string, { resolve: (c: any) => void; reject: (e: any) => void }>();
/** Replies that arrived before the caller registered a waiter (fast control replies). */
const early = new Map<string, any>();
/** User executions sent and not yet reported idle on iopub: the "busy" indicator is derived from these
 * (ipykernel also publishes busy/idle for control-channel debug_requests and internal requests). */
const userExecs = new Set<string>();
function syncBusy() {
  const k = get().kernel;
  if (k !== "idle" && k !== "busy") return;
  const next = userExecs.size ? "busy" : "idle";
  if (k !== next) set({ kernel: next });
}

/** Per-execution output sinks (notebook cells). Items mirror console items, plus "clear". */
export type OutputItem =
  | { kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { kind: "result"; data: Mime; count: number | null }
  | { kind: "display"; data: Mime; displayId?: string; update?: boolean }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] }
  | { kind: "clear"; wait: boolean }
  | { kind: "count"; count: number | null };
type Mime = Record<string, unknown>;
const sinks = new Map<string, (item: OutputItem) => void>();
/** Callbacks of rendered outputs per display_id (notebook panels): update_display_data reaches all of them. */
const displayRegs = new Map<string, Set<(data: Mime) => void>>();
export function registerDisplay(id: string, cb: (data: Mime) => void): () => void {
  let set_ = displayRegs.get(id);
  if (!set_) displayRegs.set(id, (set_ = new Set()));
  set_.add(cb);
  return () => { set_!.delete(cb); if (!set_!.size && displayRegs.get(id) === set_) displayRegs.delete(id); };
}

/** Console executions (no sink): id of the last console item before they started, for clear_output. */
const consoleMarks = new Map<string, number>();
/** clear_output(wait=True) seen for these executions: applied just before their next output. */
const pendingClear = new Set<string>();
function clearOutputs(parent: string) {
  const sink = sinks.get(parent);
  if (sink) { sink({ kind: "clear", wait: false }); return; }
  const mark = consoleMarks.get(parent);
  if (mark === undefined) return;
  set((s) => ({ console: s.console.filter((it) => it.id <= mark || it.kind === "input" || it.kind === "info") }));
}
/** Apply a deferred clear right before this execution's next output. */
function flushClear(parent: string | null) {
  if (parent && pendingClear.delete(parent)) clearOutputs(parent);
}

/** Executions whose shell reply arrived; their sink is dropped on the matching iopub idle. */
const settledReplies = new Set<string>();

/** Resolve when the shell reply for `msgId` arrives (`timeoutMs: null` = wait until the kernel dies / restarts). */
export function awaitReply(msgId: string, timeoutMs: number | null = 600_000): Promise<any> {
  if (early.has(msgId)) {
    const c = early.get(msgId);
    early.delete(msgId);
    return Promise.resolve(c);
  }
  return new Promise((resolve, reject) => {
    const timer = timeoutMs == null ? undefined : setTimeout(() => {
      if (pending.delete(msgId)) reject(new Error("timeout waiting for kernel reply"));
    }, timeoutMs);
    pending.set(msgId, { resolve: (c) => { clearTimeout(timer); resolve(c); }, reject: (e) => { clearTimeout(timer); reject(e); } });
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
  set({ variables: vars, changed, wsTick: get().wsTick + 1 });
}

function handleEvent(ev: KernelEvent) {
  const c = ev.content;
  if (ev.channel === "iopub") {
    switch (ev.msg_type) {
      case "status":
        // Only our own user executions drive the busy indicator: control-channel debug_requests
        // (sent while stopped at a breakpoint) also publish busy/idle and must not flip it.
        if (c.execution_state === "busy") { if (ev.parent_id && userExecs.has(ev.parent_id)) syncBusy(); }
        else if (c.execution_state === "idle") {
          if (ev.parent_id && userExecs.delete(ev.parent_id)) syncBusy();
          if (ev.parent_id) { consoleMarks.delete(ev.parent_id); pendingClear.delete(ev.parent_id); }
          if (ev.parent_id && get().inputRequest?.parent.parent_id === ev.parent_id) set({ inputRequest: null });
          // ipykernel sends idle after the last output of an execution: release that sink now.
          const sink = ev.parent_id && sinks.get(ev.parent_id);
          if (sink && settledReplies.has(ev.parent_id!)) { sinks.delete(ev.parent_id!); settledReplies.delete(ev.parent_id!); }
        }
        return;
      case "execute_input":
        // Only echo code we did not print ourselves (e.g. from other clients).
        // The execution starts now: its clear_output must not reach back to the output of a
        // cell that was still running when this one was queued.
        if (ev.parent_id && consoleMarks.has(ev.parent_id)) consoleMarks.set(ev.parent_id, get().console[get().console.length - 1]?.id ?? 0);
        return;
      case "stream": {
        flushClear(ev.parent_id);
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "stream", name: c.name, text: c.text });
        else pushConsole({ kind: "stream", name: c.name, text: c.text });
        return;
      }
      case "execute_result": {
        set({ execCount: c.execution_count ?? get().execCount });
        flushClear(ev.parent_id);
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "result", data: c.data, count: c.execution_count });
        else pushConsole({ kind: "result", data: c.data, count: c.execution_count });
        routeFigure(c.data, `Out[${c.execution_count}]`);
        return;
      }
      case "display_data":
      case "update_display_data": {
        const displayId = c.transient?.display_id;
        if (ev.msg_type === "display_data") flushClear(ev.parent_id);
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (ev.msg_type === "update_display_data" && displayId) {
          // Replace in place (progress bars, animations) instead of appending.
          set((s) => ({ console: s.console.map((it) => (it.kind === "display" && it.displayId === displayId ? { ...it, data: c.data } : it)) }));
          // Every rendered output with this id (any notebook cell); the running cell's sink also gets it
          // (idempotent) in case its output is not registered yet.
          displayRegs.get(displayId)?.forEach((cb) => cb(c.data));
          if (sink) sink({ kind: "display", data: c.data, displayId, update: true });
          routeFigure(c.data, `Figure ${get().figures.length + 1}`, displayId);
          return;
        }
        if (sink) sink({ kind: "display", data: c.data, displayId });
        else pushConsole({ kind: "display", data: c.data, displayId });
        routeFigure(c.data, `Figure ${get().figures.length + 1}`, displayId);
        return;
      }
      case "error": {
        flushClear(ev.parent_id);
        const sink = ev.parent_id && sinks.get(ev.parent_id);
        if (sink) sink({ kind: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] });
        else pushConsole({ kind: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] });
        return;
      }
      case "clear_output": {
        if (!ev.parent_id) return;
        // wait=True: clear just before the next output arrives (no flicker); otherwise now.
        if (c.wait) pendingClear.add(ev.parent_id);
        else { pendingClear.delete(ev.parent_id); clearOutputs(ev.parent_id); }
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
      // A cell that raised (or was interrupted) comes back without user_expressions, so its
      // snapshot is missing: ask again, or variables it did create stay hidden.
      if (c.status === "error") void refreshWorkspace().catch(() => {});
      if (c.execution_count != null) set({ execCount: c.execution_count });
      // input() was interrupted / raised: the kernel no longer waits for that reply.
      if (ev.parent_id && get().inputRequest?.parent.parent_id === ev.parent_id) set({ inputRequest: null });
      const sink = ev.parent_id && sinks.get(ev.parent_id);
      if (sink) {
        sink({ kind: "count", count: c.execution_count ?? null });
        // Keep the sink until iopub reports idle (outputs may still be in flight on the other socket).
        settledReplies.add(ev.parent_id!);
        setTimeout(() => { if (sinks.delete(ev.parent_id!)) settledReplies.delete(ev.parent_id!); }, 2000);
      }
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
    // The prompt is answered in the Command Window: bring it up, or a notebook cell (or a
    // script) calling input() looks hung while that tab is hidden.
    import("./layout").then((l) => { try { l.dockApi()?.getPanel("console")?.api.setActive(); } catch { /* layout not ready */ } });
  }
}

/** Images / plotly bundles also go to the Figures panel, MATLAB style. */
function routeFigure(data: Record<string, unknown>, title: string, displayId?: string) {
  let fig: Omit<Figure, "id"> | null = null;
  if (data["application/vnd.plotly.v1+json"]) {
    const b = data["application/vnd.plotly.v1+json"] as any;
    fig = { title, kind: "plotly", data: b.data, layout: b.layout, displayId };
  } else if (data["image/png"]) fig = { title, kind: "png", data: data["image/png"], displayId };
  else if (data["image/svg+xml"]) fig = { title, kind: "svg", data: data["image/svg+xml"], displayId };
  if (!fig) return;
  if (displayId) {
    const existing = get().figures.find((f) => f.displayId === displayId);
    if (existing) { set((s) => ({ figures: s.figures.map((f) => (f.id === existing.id ? { ...f, data: fig!.data, layout: fig!.layout } : f)) })); return; }
  }
  addFigure(fig);
}

/** Reject every outstanding reply and drop output sinks (kernel died / restarted / lagged). */
function settlePending(reason: string, resolveInstead = false) {
  for (const [id, p] of pending) {
    pending.delete(id);
    if (resolveInstead) p.resolve({ status: "unknown", lagged: true });
    else p.reject(new Error(reason));
  }
  for (const [id, sink] of sinks) { sinks.delete(id); sink({ kind: "count", count: null }); }
  settledReplies.clear();
  consoleMarks.clear();
  pendingClear.clear();
  userExecs.clear();
  early.clear();
}

/** Grace period for a heartbeat loss before pending executions are given up. */
const HB_GRACE_MS = 30_000;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
/** The kernel session is over: settle everything that waited on it. */
function kernelGone(detail: string | null, reason = "kernel died") {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  settlePending(reason);
  resetDebugState();
  set({ inputRequest: null });
  if (detail && reason === "kernel died") pushConsole({ kind: "info", text: `Kernel died: ${detail}` });
}

/** Debugger state belongs to one kernel session: drop it when that session ends (death, restart, start). */
function resetDebugState() {
  set((s) => ({ debug: { ...s.debug, active: false, stopped: false, threadId: null, reason: null, frames: [], frameId: null, variables: [], scopes: [], cellFiles: {}, exceptionInfo: null } }));
}

/** Replies may have been lost (events dropped under load, or a channel reconnected): once the kernel
 * answers a cheap request, settle everything older. `force` runs even while another resync waits
 * (its marker may itself have been lost; a newer resync settles that marker too). */
let resyncing = false;
let resyncSentAt = 0;
async function resync(note: string, force = false) {
  pushConsole({ kind: "info", text: note });
  // While one waits, further lag reports only start another after a while: the marker's own
  // reply can be among the dropped events, and that wait would then never end.
  if (resyncing && !force && Date.now() - resyncSentAt < 5000) return;
  resyncing = true;
  resyncSentAt = Date.now();
  try {
    const stale = [...pending.keys()];
    const staleExecs = [...userExecs];
    const id = await invoke<string>("is_complete", { code: "" });
    // Shell requests are answered in order: the marker reply means everything older is done.
    // No timeout: a long print-heavy cell is still running until then. If the kernel dies or
    // restarts meanwhile, settlePending has already settled everything (and rejects this wait).
    try { await awaitReply(id, null); } catch { return; }
    for (const k of stale) { const p = pending.get(k); if (p) { pending.delete(k); p.resolve({ status: "unknown", lagged: true }); } }
    for (const k of stale) { const sink = sinks.get(k); if (sink) { sinks.delete(k); settledReplies.delete(k); sink({ kind: "count", count: null }); } }
    for (const k of staleExecs) { userExecs.delete(k); consoleMarks.delete(k); pendingClear.delete(k); }
    syncBusy();
  } catch {
    /* kernel not running */
  } finally {
    resyncing = false;
  }
}

let started = false;
const unlisteners: (() => void)[] = [];
export async function initKernelBridge() {
  if (started) return;
  started = true;
  unlisteners.push(await listen<KernelEvent[]>("kernel-events", (e) => { for (const ev of e.payload) handleEvent(ev); }));
  unlisteners.push(await listen<number>("kernel-lagged", (e) => resync(`${e.payload} kernel messages were dropped (output too fast); re-synchronizing.`)));
  unlisteners.push(await listen<any>("kernel-status", (e) => {
    const p = e.payload;
    // "idle" also reports a recovered heartbeat: keep showing busy while our executions run.
    const state = p.state === "idle" && userExecs.size ? "busy" : p.state;
    set({ kernel: state, python: p.python ?? get().python, cwd: p.cwd ?? get().cwd, kernelDetail: p.detail ?? null });
    if (p.state === "dead") {
      if (p.reason === "heartbeat") {
        // The heartbeat may come back (stall, network blip): keep pending executions and their
        // output sinks for a while, so a still-running cell's output lands in its cell.
        if (!graceTimer) {
          pushConsole({ kind: "info", text: `Connection lost: ${p.detail ?? "kernel not responding"}. Waiting up to ${HB_GRACE_MS / 1000} s for it to recover.` });
          graceTimer = setTimeout(() => { graceTimer = null; kernelGone(p.detail); }, HB_GRACE_MS);
        }
      } else {
        kernelGone(p.detail); // the process exited / the link is gone for good
      }
    } else if (graceTimer) {
      // Recovered ("idle" / "busy"), or a new session ("starting" / "stopped") replaces the old one.
      const recovered = p.state === "idle" || p.state === "busy";
      if (recovered) { clearTimeout(graceTimer); graceTimer = null; pushConsole({ kind: "info", text: "Kernel is responding again." }); }
      else kernelGone(null, "kernel restarted");
    }
    if (p.reason === "reconnected") void resync("The connection to the kernel was interrupted and has been re-established; replies sent meanwhile may be lost.", true);
  }));
  const pythons = await invoke<string[]>("detect_pythons");
  const overrides = await invoke<{ python: string | null; cwd: string | null }>("launch_overrides").catch(() => ({ python: null, cwd: null }));
  const envPython = overrides.python;
  if (envPython) { set({ remote: null, connectionFile: null }); localStorage.setItem("pide.remote", "null"); }
  const saved = envPython ?? localStorage.getItem("pide.python");
  set({ pythons: saved && !pythons.includes(saved) ? [saved, ...pythons] : pythons, python: saved ?? pythons[0] ?? "python3" });
  const cwdOverride = overrides.cwd;
  if (cwdOverride) set({ cwd: cwdOverride });
  else if (!get().cwd) set({ cwd: localStorage.getItem("pide.cwd") ?? (await invoke<string>("home_dir")) });
}

// Vite HMR re-evaluates this module: drop the old listeners or every event is handled twice.
import.meta.hot?.dispose(() => { for (const u of unlisteners.splice(0)) u(); });

/** In-flight start / restart; execute() waits on it (the backend has no kernel meanwhile). */
let starting: Promise<void> | null = null;
/** Bumped to abort a start that has not reached the backend yet (restart during startup). */
let startGen = 0;
export function startKernel() {
  if (!starting) starting = startKernelInner().finally(() => (starting = null));
  return starting;
}

async function startKernelInner() {
  const gen = startGen;
  // A heartbeat grace period of the previous session ends here: its executions are over.
  if (graceTimer) kernelGone(null, "kernel restarted");
  let { python, cwd, remote, connectionFile } = get();
  if (!remote && !connectionFile && cwd) {
    // A cwd left over from a remote session may not exist here.
    const ok = await invoke("list_dir", { path: cwd }).then(() => true).catch(() => false);
    if (!ok) { cwd = await invoke<string>("home_dir").catch(() => cwd!); set({ cwd }); localStorage.setItem("pide.cwd", cwd); }
  }
  if (gen !== startGen) return;
  set({ console: [...get().console], inputRequest: null });
  resetDebugState();
  pushConsole({ kind: "info", text: remote ? `Starting remote kernel on ${remote.host}: ${remote.python}` : connectionFile ? `Connecting to kernel: ${connectionFile}` : `Starting kernel: ${python}` });
  try {
    await invoke("start_kernel", { python, cwd, remote: remote ? { host: remote.host, port: remote.port ?? null, python: remote.python, cwd: remote.cwd || null } : null, connectionFile });
    pushConsole({ kind: "info", text: "Kernel ready." });
    if (remote || connectionFile) {
      // Browse the machine the kernel runs on.
      const { kernelInfo } = await import("./fs");
      const info = await kernelInfo().catch(() => null);
      if (info) { set({ cwd: info.cwd }); pushConsole({ kind: "info", text: `Remote files: ${info.host}:${info.cwd}` }); }
    }
    startLsp().catch((e) => pushConsole({ kind: "info", text: `LSP: ${e}` }));
    // Make matplotlib figures appear inline (routed to the Figures panel).
    await runSilent("try:\n import matplotlib\n matplotlib.use('module://matplotlib_inline.backend_inline')\nexcept Exception: pass");
    await refreshWorkspace();
    // Dev helpers (debug builds only): PIDE_AUTORUN runs Python once the kernel
    // is up, PIDE_DEV_SCRIPT runs JS for scripted UI checks.
    // Not awaited: execute() waits for `starting`, which is this very function.
    if (import.meta.env.DEV && !autorunDone) {
      autorunDone = true;
      void devAutorun();
    }
  } catch (e) {
    if (gen !== startGen || String(e).includes("kernel start cancelled")) pushConsole({ kind: "info", text: "Kernel start cancelled." });
    else pushConsole({ kind: "info", text: `Failed to start kernel: ${e}` });
  }
}
let autorunDone = false;
async function devAutorun() {
  const auto = await invoke<string | null>("dev_autorun").catch(() => null);
  if (auto) await execute(auto);
  const script = await invoke<string | null>("dev_script").catch(() => null);
  if (script) new Function(script)();
}

/** In-flight restart, registered synchronously so execute() never slips between cancelling
 *  the old start and registering the new one. A restart pressed during a restart aborts the
 *  in-flight start (e.g. a hung SSH launch) and restarts again after it. */
let restarting: Promise<void> | null = null;
export function restartKernel(): Promise<void> {
  const prev = restarting;
  // The restart in progress may be waiting for its setup requests (up to 10 min): end them.
  if (prev) { startGen++; settlePending("kernel restarted"); void invoke("cancel_start").catch(() => {}); }
  const p: Promise<void> = (prev ? prev.then(restartKernelInner) : restartKernelInner()).finally(() => {
    if (restarting === p) restarting = null;
  });
  restarting = p;
  return p;
}

async function restartKernelInner() {
  pushConsole({ kind: "info", text: "Restarting kernel..." });
  if (starting) {
    // A start in progress (possibly a minute-long SSH launch, or its setup requests to an
    // unresponsive kernel) is aborted, not waited out.
    startGen++;
    settlePending("kernel restarted");
    await invoke("cancel_start").catch(() => {});
    await starting; // never rejects: startKernelInner reports its own errors
  }
  settlePending("kernel restarted");
  set({ variables: [], changed: new Set() });
  resetDebugState();
  await startKernel();
}

export async function interrupt() {
  await invoke("interrupt_kernel");
}

/** Execute user code: echoes it in the console and records history. */
export async function execute(code: string, { echo = true, sink, history = true }: { echo?: boolean; sink?: (item: OutputItem) => void; history?: boolean } = {}): Promise<any> {
  if (!code.trim()) return;
  // During start / restart the backend has no kernel yet ("kernel not running"): wait for it.
  if (restarting || starting) {
    while (restarting || starting) await (restarting ?? starting);
  } else if (get().kernel === "stopped" || get().kernel === "dead") await startKernel();
  const id = crypto.randomUUID();
  if (sink) sinks.set(id, sink);
  else consoleMarks.set(id, get().console[get().console.length - 1]?.id ?? 0);
  // No timeout: user code may legitimately run for hours. The wait ends with the reply, or
  // settlePending() when the kernel dies / restarts.
  const reply = awaitReply(id, null);
  userExecs.add(id);
  syncBusy();
  try {
    await invoke<string>("execute", { code, opts: { workspace: true, include_hidden: get().showHidden, msg_id: id } });
  } catch (e) {
    sinks.delete(id);
    consoleMarks.delete(id);
    userExecs.delete(id);
    syncBusy();
    const p = pending.get(id); if (p) { pending.delete(id); p.reject(new Error(String(e))); }
    pushConsole({ kind: "info", text: `Cannot execute: ${e}` });
    reply.catch(() => {});
    return { status: "error", error: String(e) };
  }
  if (echo) pushConsole({ kind: "input", code, count: get().execCount + 1, msgId: id });
  if (history) addHistory(code);
  // Many callers fire and forget: report an aborted execution (kernel died / restarted) as an
  // error reply instead of rejecting, like a failed send above.
  return reply.catch((e) => ({ status: "error", error: String(e?.message ?? e) }));
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

/** The payload of a helper call, or an error that says why there is none: the request was
 * aborted (a cell queued before it raised) or its reply was lost (lagged / reconnected). */
function helperData(reply: any, key: string): any {
  const ue = reply?.user_expressions?.[key];
  if (!ue) throw new Error(`the kernel did not answer (${reply?.status ?? "no reply"}); it is retried after the next execution`);
  if (ue.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  return ue.data["application/x-pide+json"];
}

export async function fetchDetail(path: string, win: { row0: number; row1: number; col0: number; col1: number; index?: number[] }): Promise<DetailWindow> {
  const id = await invoke<string>("variable_detail", { path, win });
  const reply = await awaitReply(id);
  return helperData(reply, "detail");
}

export interface ImageData_ { path: string; shape: number[]; dtype: string; layout: string; extra: number[]; index: number[]; h: number; w: number; channels: number; vmin: number; vmax: number; step: number; data: string; error?: string }
export async function fetchImage(path: string, opts: { index?: number[]; vmin?: number | null; vmax?: number | null; layout?: string }): Promise<ImageData_> {
  const id = await invoke<string>("variable_image", { path, opts });
  const reply = await awaitReply(id);
  return helperData(reply, "image");
}

export async function fetchPlotExpr(expr: string): Promise<any> {
  const id = await invoke<string>("plot_expr", { expr });
  const reply = await awaitReply(id);
  return helperData(reply, "plot");
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
  // A typo must not become the working folder (persisted, used to restart the language
  // servers, while the kernel's own chdir fails silently).  Local folders only: a remote
  // listing waits behind a running cell.
  if (!get().remote && !get().connectionFile) {
    const ok = await invoke("list_dir", { path }).then(() => true).catch(() => false);
    if (!ok) { pushConsole({ kind: "info", text: `Not a folder: ${path}` }); return; }
  }
  if (!get().remote && !get().connectionFile) localStorage.setItem("pide.cwd", path);
  set({ cwd: path });
  // The language servers' workspace root follows the cwd (no-op when the root is unchanged).
  startLsp().catch(() => {});
  // Also while busy: shell requests run in order, so the chdir lands after the running cell.
  // Not awaited past sending (that could take as long as the cell).
  if (get().kernel !== "idle" && get().kernel !== "busy") return;
  try {
    const id = await invoke<string>("execute", { code: `import os as _os; _os.chdir(${JSON.stringify(path)})`, opts: { silent: true, store_history: false, workspace: false } });
    awaitReply(id, null).catch(() => {});
  } catch (e) {
    pushConsole({ kind: "info", text: `chdir: ${e}` });
  }
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
