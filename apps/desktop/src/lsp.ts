// Minimal LSP client over the Tauri relay, wired into Monaco.
// basedpyright: completion / hover / signature / definition / diagnostics.
// ruff: lint diagnostics / formatting.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import { get, pushConsole, set } from "./store";
import { formatWithTool, toolSettings } from "./tools";

type Json = any;
export type ServerName = "pyright" | "ruff";

interface Doc { uri: string; version: number; text: string; languageId: string }
const docs = new Map<string, Doc>();
const clients = new Map<ServerName, LspClient>();
let monacoRef: typeof Monaco | null = null;

export function lspStatus(): Record<ServerName, string> {
  return { pyright: clients.get("pyright")?.state ?? "off", ruff: clients.get("ruff")?.state ?? "off" };
}
function publishStatus() {
  set({ lsp: lspStatus() });
}

class LspClient {
  state: "starting" | "running" | "failed" | "off" = "off";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private initialized: Promise<void> | null = null;
  capabilities: Json = {};
  /** Backend session id from lsp_start; events from older sessions are ignored. */
  gen: number | null = null;
  private started: { cwd: string; python: string } | null = null;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(public name: ServerName, public cmd: string, public args: string[]) {}

  async start(cwd: string, python: string) {
    this.state = "starting";
    this.started = { cwd, python };
    publishStatus();
    let root: string | null;
    try {
      this.gen = await invoke<number>("lsp_start", { name: this.name, cmd: this.cmd, args: this.args, cwd });
      root = await workspaceRoot(cwd);
    } catch (e) {
      if ((this.state as LspClient["state"]) === "off") return; // disposed meanwhile
      this.state = "failed";
      publishStatus();
      pushConsole({ kind: "info", text: `${this.name}: failed to start: ${e}` });
      return;
    }
    const gen = this.gen;
    const useRoot = root !== null;
    const rootUri = useRoot ? monacoRef!.Uri.file(root!).toString() : null;
    this.initialized = this.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: useRoot ? [{ uri: rootUri, name: root!.split(/[\\/]/).pop() }] : null,
      initializationOptions: this.name === "ruff" ? { settings: { lint: { enable: true }, organizeImports: true } } : {},
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } }, contextSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
          definition: {},
          publishDiagnostics: { relatedInformation: false },
          formatting: {},
        },
        notebookDocument: { synchronization: { dynamicRegistration: false, executionSummarySupport: false } },
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
      },
    }).then((r) => {
      if (this.gen !== gen) return; // this session already exited or was disposed
      this.capabilities = r?.capabilities ?? {};
      if (this.name === "pyright") registerCompletion(monacoRef!, r?.capabilities?.completionProvider?.triggerCharacters);
      this.notify("initialized", {});
      if (this.name === "pyright") {
        this.notify("workspace/didChangeConfiguration", { settings: { python: { pythonPath: python, analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" } } } });
      }
      this.state = "running";
      publishStatus();
      for (const d of docs.values()) this.notify("textDocument/didOpen", { textDocument: { uri: d.uri, languageId: d.languageId, version: d.version, text: d.text } });
      for (const nb of notebooks.values()) this.notify("notebookDocument/didOpen", notebookOpenParams(nb));
    }).catch((e) => {
      if (this.gen !== gen) return; // exited (restart handles it) or disposed
      this.state = "failed";
      publishStatus();
      pushConsole({ kind: "info", text: `${this.name}: initialize failed: ${e}` });
    });
    return this.initialized;
  }

  private rejectPending(why: string) {
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error(why)); }
  }

  dispose() {
    this.state = "off";
    this.gen = null;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.rejectPending(`${this.name} restarted`);
    clearMarkers(this.name);
  }

  /** The server process died: fail its requests now, drop its markers, and restart with backoff. */
  exited(detail: string) {
    if (this.state === "off") return;
    this.gen = null;
    this.state = "failed";
    this.rejectPending(`${this.name} exited`);
    clearMarkers(this.name);
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    const n = this.crashes.length;
    if (n > 3 || !this.started) {
      pushConsole({ kind: "info", text: `${this.name} exited: ${detail} (gave up restarting)` });
      publishStatus();
      return;
    }
    pushConsole({ kind: "info", text: `${this.name} exited: ${detail}; restarting…` });
    this.state = "starting";
    publishStatus();
    const { cwd, python } = this.started;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (clients.get(this.name) !== this || this.state !== "starting") return;
      // Serialized with startLsp so a full restart and this one never interleave.
      lspChain = lspChain.then(() => (clients.get(this.name) === this && this.state === "starting" ? this.start(cwd, python) : undefined)).catch(() => {});
    }, 1000 * 2 ** (n - 1));
  }

  request(method: string, params: Json, timeoutMs = 15000, token?: Monaco.CancellationToken): Promise<Json> {
    flushPendingChanges();
    const id = this.nextId++;
    const p = new Promise<Json>((resolve, reject) => {
      const cancel = (why: string) => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new Error(why));
      };
      this.pending.set(id, { resolve, reject });
      setTimeout(() => cancel(`${this.name} ${method} timed out`), timeoutMs);
      token?.onCancellationRequested(() => cancel(`${this.name} ${method} cancelled`));
    });
    invoke("lsp_send", { name: this.name, msg: { jsonrpc: "2.0", id, method, params } }).catch((e) => {
      const q = this.pending.get(id);
      if (q) { this.pending.delete(id); q.reject(new Error(String(e))); }
    });
    return p;
  }
  notify(method: string, params: Json) {
    invoke("lsp_send", { name: this.name, msg: { jsonrpc: "2.0", method, params } }).catch(() => {});
  }
  private respond(id: Json, result: Json) {
    invoke("lsp_send", { name: this.name, msg: { jsonrpc: "2.0", id, result } }).catch(() => {});
  }

  handle(msg: Json) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Request from the server.
      switch (msg.method) {
        case "workspace/configuration": {
          const python = get().python ?? "python3";
          const items: Json[] = msg.params?.items ?? [];
          this.respond(msg.id, items.map((it) => {
            const s = it.section ?? "";
            if (s === "python") return { pythonPath: python, analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" } };
            if (s === "python.analysis" || s === "basedpyright.analysis") return { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" };
            if (s === "basedpyright") return { analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" } };
            return {};
          }));
          return;
        }
        case "workspace/workspaceFolders": {
          this.respond(msg.id, null);
          return;
        }
        default:
          this.respond(msg.id, null); // registerCapability, workDoneProgress/create, ...
          return;
      }
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      setDiagnostics(this.name, msg.params.uri, msg.params.diagnostics ?? []);
    } else if (msg.method === "window/showMessage") {
      pushConsole({ kind: "info", text: `${this.name}: ${msg.params?.message}` });
    }
  }
}

// ------------------------------------------------------------------ setup --

let listening = false;
export async function initLsp(monaco: typeof Monaco) {
  monacoRef = monaco;
  if (listening) return;
  listening = true;
  await listen<{ server: ServerName; gen: number; msg: Json }>("lsp-message", (e) => {
    const c = clients.get(e.payload.server);
    if (c && c.gen === e.payload.gen) c.handle(e.payload.msg);
  });
  await listen<{ server: ServerName; gen: number; detail: string }>("lsp-exit", (e) => {
    const c = clients.get(e.payload.server);
    if (c && c.gen === e.payload.gen) c.exited(e.payload.detail);
  });
  setInterval(() => invoke("lsp_check").catch(() => {}), 5000);
  registerProviders(monaco);
}

/** (Re)start servers for the current interpreter and working directory (serialized). */
let lspChain: Promise<void> = Promise.resolve();
export function startLsp(): Promise<void> {
  const next = lspChain.then(() => startLspInner()).catch(() => {});
  lspChain = next;
  return next;
}

/** A home directory or / as workspace makes pyright enumerate everything;
 * in that case run without a workspace folder (open files still work). */
async function workspaceRoot(cwd: string): Promise<string | null> {
  const home = await invoke<string>("home_dir");
  const strip = (p: string) => p.replace(/[\\/]$/, "");
  return cwd !== "/" && strip(cwd) !== strip(home) && !get().remote && !get().connectionFile ? cwd : null;
}

/** Interpreter + workspace root the running servers were started with. */
let lspKey = "";
async function startLspInner() {
  const python = get().python ?? "python3";
  const cwd = get().cwd ?? "/";
  const det = await invoke<{ pyright: string | null; ruff: string | null }>("detect_lsp", { python });
  const t0 = toolSettings();
  const wantRuff = (t0.linter === "ruff" || t0.formatter === "ruff") && !!det.ruff;
  const key = JSON.stringify([python, await workspaceRoot(cwd).catch(() => null)]);
  // A kernel restart alone must not throw away pyright's index: restart only when the
  // interpreter, the workspace root or the set of servers changed (or one gave up).
  if (key === lspKey && clients.has("pyright") === !!det.pyright && clients.has("ruff") === wantRuff && [...clients.values()].every((c) => c.state === "running" || c.state === "starting")) return;
  lspKey = key;
  for (const c of clients.values()) { c.dispose(); await invoke("lsp_stop", { name: c.name }).catch(() => {}); }
  clients.clear();
  const missing: string[] = [];
  if (det.pyright) clients.set("pyright", new LspClient("pyright", det.pyright, ["--stdio"]));
  else missing.push("basedpyright");
  const t = toolSettings();
  const needRuff = t.linter === "ruff" || t.formatter === "ruff";
  if (!needRuff) { /* ruff not selected */ }
  else if (det.ruff) clients.set("ruff", new LspClient("ruff", det.ruff, ["server"]));
  else missing.push("ruff");
  if (missing.length) pushConsole({ kind: "info", text: `Language tools not found for ${python}: ${missing.join(", ")}. Install with: pip install ${missing.join(" ")}` });
  publishStatus();
  await Promise.all([...clients.values()].map((c) => c.start(cwd, python).catch(() => {})));
}

// -------------------------------------------------------------- documents --

export function openDocument(uri: string, text: string, languageId = "python") {
  const d = { uri, version: 1, text, languageId };
  docs.set(uri, d);
  for (const c of clients.values()) if (c.state === "running") c.notify("textDocument/didOpen", { textDocument: d });
}
/** Debounced edits are queued here; any request flushes them first so servers never see stale text. */
const pendingChanges = new Map<string, () => void>();
export function flushPendingChanges() {
  for (const [k, fn] of pendingChanges) { pendingChanges.delete(k); fn(); }
}
export function queueDocumentChange(uri: string, getText: () => string, apply: (text: string) => void, delayMs = 150) {
  const prev = (pendingChanges.get(uri) as any)?.timer;
  if (prev) clearTimeout(prev);
  const fn = () => apply(getText());
  const timer = setTimeout(() => { if (pendingChanges.delete(uri)) fn(); }, delayMs);
  (fn as any).timer = timer;
  pendingChanges.set(uri, fn);
}

export function changeDocument(uri: string, text: string) {
  const d = docs.get(uri);
  if (!d) return;
  d.version++;
  d.text = text;
  for (const c of clients.values()) if (c.state === "running") c.notify("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text }] });
}
export function saveDocument(uri: string) {
  for (const c of clients.values()) if (c.state === "running") c.notify("textDocument/didSave", { textDocument: { uri } });
}
export function closeDocument(uri: string) {
  docs.delete(uri);
  for (const c of clients.values()) if (c.state === "running") c.notify("textDocument/didClose", { textDocument: { uri } });
  const m = monacoRef?.editor.getModel(monacoRef.Uri.parse(uri));
  if (m && monacoRef) for (const owner of ["pyright", "ruff"]) monacoRef.editor.setModelMarkers(m, owner, []);
}

// -------------------------------------------------------------- notebooks --

interface NbCell { uri: string; text: string; version: number }
interface NbDoc { uri: string; version: number; cells: NbCell[] }
const notebooks = new Map<string, NbDoc>();

function notebookOpenParams(nb: NbDoc) {
  return {
    notebookDocument: { uri: nb.uri, notebookType: "jupyter-notebook", version: nb.version, cells: nb.cells.map((c) => ({ kind: 2, document: c.uri })) },
    cellTextDocuments: nb.cells.map((c) => ({ uri: c.uri, languageId: "python", version: c.version, text: c.text })),
  };
}
const running = () => [...clients.values()].filter((c) => c.state === "running");

/** Open (or fully re-open) a notebook with its code cells. */
export function openNotebookDoc(uri: string, cells: { uri: string; text: string }[]) {
  const prev = notebooks.get(uri);
  if (prev) closeNotebookDoc(uri);
  const nb: NbDoc = { uri, version: (prev?.version ?? 0) + 1, cells: cells.map((c) => ({ ...c, version: 1 })) };
  notebooks.set(uri, nb);
  for (const c of running()) c.notify("notebookDocument/didOpen", notebookOpenParams(nb));
}

/** Structure changed (cells added/removed/moved/retyped): simplest correct sync is close + open. */
export function syncNotebookStructure(uri: string, cells: { uri: string; text: string }[]) {
  const nb = notebooks.get(uri);
  if (!nb) return openNotebookDoc(uri, cells);
  const same = nb.cells.length === cells.length && nb.cells.every((c, i) => c.uri === cells[i].uri);
  if (same) return;
  openNotebookDoc(uri, cells);
}

export function changeNotebookCell(uri: string, cellUri: string, text: string) {
  const nb = notebooks.get(uri);
  const cell = nb?.cells.find((c) => c.uri === cellUri);
  if (!nb || !cell) return;
  cell.text = text;
  cell.version++;
  nb.version++;
  for (const c of running()) c.notify("notebookDocument/didChange", { notebookDocument: { uri, version: nb.version }, change: { cells: { textContent: [{ document: { uri: cellUri, version: cell.version }, changes: [{ text }] }] } } });
}

export function closeNotebookDoc(uri: string) {
  const nb = notebooks.get(uri);
  if (!nb) return;
  notebooks.delete(uri);
  for (const c of running()) c.notify("notebookDocument/didClose", { notebookDocument: { uri }, cellTextDocuments: nb.cells.map((x) => ({ uri: x.uri })) });
  if (monacoRef) for (const x of nb.cells) { const m = monacoRef.editor.getModel(monacoRef.Uri.parse(x.uri)); if (m) for (const owner of ["pyright", "ruff"]) monacoRef.editor.setModelMarkers(m, owner, []); }
}

/** Format one document (file or notebook cell) with ruff; returns the new text or null. */
export async function formatDocument(uri: string, text: string): Promise<string | null> {
  const fmt = toolSettings().formatter;
  if (fmt === "none") return null;
  if (fmt !== "ruff") return formatWithTool(text, uri.split("/").pop()?.split("#")[0] || "cell.py");
  const c = clients.get("ruff");
  if (!c || c.state !== "running") { pushConsole({ kind: "info", text: "ruff server is not running (install ruff in the kernel's environment)." }); return null; }
  const edits = await c.request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } }).catch(() => null);
  if (!edits || !Array.isArray(edits) || !edits.length) return null;
  // Apply LSP text edits (line/character offsets) to the string, last edit first.
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

// ------------------------------------------------------------ diagnostics --

/** Remove every marker a server put on any model (it stopped or crashed). */
function clearMarkers(owner: string) {
  const monaco = monacoRef;
  if (!monaco) return;
  for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, owner, []);
}

function setDiagnostics(owner: string, uri: string, diags: Json[]) {
  const monaco = monacoRef;
  if (!monaco) return;
  if (owner === "ruff" && toolSettings().linter !== "ruff") diags = []; // ruff kept only for formatting
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  const sev: Record<number, Monaco.MarkerSeverity> = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint };
  monaco.editor.setModelMarkers(model, owner, diags.map((d) => ({
    severity: sev[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
    message: d.message,
    source: d.source ?? owner,
    code: typeof d.code === "object" ? String(d.code?.value ?? "") : d.code != null ? String(d.code) : undefined,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: (d.tags ?? []).map((t: number) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
  })));
}

// -------------------------------------------------------------- providers --

function pos(p: Monaco.Position) {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}
function toRange(monaco: typeof Monaco, r: Json): Monaco.IRange {
  return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
}
function markdown(c: Json): Monaco.IMarkdownString[] {
  if (!c) return [];
  if (typeof c === "string") return [{ value: c }];
  if (Array.isArray(c)) return c.flatMap(markdown);
  if (c.language) return [{ value: "```" + c.language + "\n" + c.value + "\n```" }];
  return [{ value: c.value ?? "" }];
}
const KIND_NAMES = ["", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"];

const editsOf = (monaco: typeof Monaco, edits: Json[] | undefined) => (edits ?? []).map((e) => ({ range: toRange(monaco, e.range), text: e.newText }));

/** (Re)register the completion provider; trigger characters come from the server once it is initialized. */
let completionReg: Monaco.IDisposable | null = null;
let completionChars = "";
function registerCompletion(monaco: typeof Monaco, serverChars?: string[]) {
  const chars = serverChars ?? ["."];
  if (completionReg && chars.join("") === completionChars) return;
  completionReg?.dispose();
  completionChars = chars.join("");
  const py = () => { const c = clients.get("pyright"); return c && c.state === "running" ? c : null; };
  completionReg = monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: chars,
    async provideCompletionItems(model, position, context, token) {
      const c = py();
      if (!c) return { suggestions: [] };
      const triggerKind = context.triggerKind + 1; // Monaco 0-based -> LSP 1-based (Invoked / TriggerCharacter / Incomplete)
      const ctx = triggerKind === 2 ? { triggerKind, triggerCharacter: context.triggerCharacter } : { triggerKind };
      const r = await c.request("textDocument/completion", { textDocument: { uri: model.uri.toString() }, position: pos(position), context: ctx }, 15000, token).catch(() => null);
      const items: Json[] = Array.isArray(r) ? r : r?.items ?? [];
      const word = model.getWordUntilPosition(position);
      const defRange: Monaco.IRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        incomplete: !!r?.isIncomplete,
        suggestions: items.map((it) => ({
          label: it.label,
          kind: (monaco.languages.CompletionItemKind as any)[KIND_NAMES[it.kind] ?? "Text"] ?? monaco.languages.CompletionItemKind.Text,
          detail: it.detail,
          documentation: it.documentation ? markdown(it.documentation)[0] : undefined,
          insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: it.textEdit?.range ? toRange(monaco, it.textEdit.range) : defRange,
          sortText: it.sortText,
          filterText: it.filterText,
          additionalTextEdits: it.additionalTextEdits ? editsOf(monaco, it.additionalTextEdits) : undefined,
          // keep the raw item for resolve
          _lsp: it,
        } as Monaco.languages.CompletionItem)),
      };
    },
    async resolveCompletionItem(item, token) {
      const c = py();
      const raw = (item as any)._lsp;
      if (!c || !raw) return item;
      const r = await c.request("completionItem/resolve", raw, 15000, token).catch(() => null);
      if (r?.documentation) item.documentation = markdown(r.documentation)[0];
      if (r?.detail) item.detail = r.detail;
      if (r?.additionalTextEdits) item.additionalTextEdits = editsOf(monaco, r.additionalTextEdits);
      return item;
    },
  });
}

function registerProviders(monaco: typeof Monaco) {
  const py = () => { const c = clients.get("pyright"); return c && c.state === "running" ? c : null; };
  const ruff = () => { const c = clients.get("ruff"); return c && c.state === "running" ? c : null; };

  registerCompletion(monaco);

  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position, token) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/hover", { textDocument: { uri: model.uri.toString() }, position: pos(position) }, 15000, token).catch(() => null);
      if (!r?.contents) return null;
      return { contents: markdown(r.contents), range: r.range ? toRange(monaco, r.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position, token) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/signatureHelp", { textDocument: { uri: model.uri.toString() }, position: pos(position) }, 15000, token).catch(() => null);
      if (!r?.signatures?.length) return null;
      return {
        dispose() {},
        value: {
          activeSignature: r.activeSignature ?? 0,
          activeParameter: r.activeParameter ?? 0,
          signatures: r.signatures.map((s: Json) => ({
            label: s.label,
            documentation: s.documentation ? markdown(s.documentation)[0] : undefined,
            activeParameter: s.activeParameter,
            parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label, documentation: p.documentation ? markdown(p.documentation)[0] : undefined })),
          })),
        },
      };
    },
  });

  monaco.languages.registerDefinitionProvider("python", {
    async provideDefinition(model, position, token) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/definition", { textDocument: { uri: model.uri.toString() }, position: pos(position) }, 15000, token).catch(() => null);
      if (!r) return null;
      const locs: Json[] = Array.isArray(r) ? r : [r];
      return locs.map((l) => ({ uri: monaco.Uri.parse(l.targetUri ?? l.uri), range: toRange(monaco, l.targetSelectionRange ?? l.targetRange ?? l.range) }));
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider("python", {
    async provideDocumentFormattingEdits(model) {
      const fmt = toolSettings().formatter;
      if (fmt !== "ruff") {
        if (fmt === "none") return [];
        const out = await formatWithTool(model.getValue(), model.uri.path.split("/").pop() || "file.py");
        return out === null ? [] : [{ range: model.getFullModelRange(), text: out }];
      }
      const c = ruff();
      if (!c) return [];
      const r = await c.request("textDocument/formatting", { textDocument: { uri: model.uri.toString() }, options: { tabSize: 4, insertSpaces: true } }).catch(() => null);
      return (r ?? []).map((e: Json) => ({ range: toRange(monaco, e.range), text: e.newText }));
    },
  });

  // Go-to-definition into another file: open it in a new editor tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const line = selectionOrPosition && "lineNumber" in selectionOrPosition ? selectionOrPosition.lineNumber : (selectionOrPosition as Monaco.IRange | undefined)?.startLineNumber;
      import("./layout").then((l) => l.openFile(resource.fsPath, line));
      return true;
    },
  });
}
