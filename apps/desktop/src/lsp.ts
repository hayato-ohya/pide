// Minimal LSP client over the Tauri relay, wired into Monaco.
// basedpyright: completion / hover / signature / definition / diagnostics.
// ruff: lint diagnostics / formatting.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import { get, pushConsole, set } from "./store";

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
  constructor(public name: ServerName, public cmd: string, public args: string[]) {}

  async start(cwd: string, python: string) {
    this.state = "starting";
    publishStatus();
    await invoke("lsp_start", { name: this.name, cmd: this.cmd, args: this.args, cwd });
    // A home directory or / as workspace makes pyright enumerate everything;
    // in that case run without a workspace folder (open files still work).
    const home = await invoke<string>("home_dir");
    const useRoot = cwd !== "/" && cwd.replace(/\/$/, "") !== home.replace(/\/$/, "");
    const rootUri = useRoot ? "file://" + cwd : null;
    this.initialized = this.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: useRoot ? [{ uri: rootUri, name: cwd.split("/").pop() }] : null,
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
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
      },
    }).then((r) => {
      this.capabilities = r?.capabilities ?? {};
      this.notify("initialized", {});
      if (this.name === "pyright") {
        this.notify("workspace/didChangeConfiguration", { settings: { python: { pythonPath: python, analysis: { typeCheckingMode: "standard", diagnosticMode: "openFilesOnly" } } } });
      }
      this.state = "running";
      publishStatus();
      for (const d of docs.values()) this.notify("textDocument/didOpen", { textDocument: { uri: d.uri, languageId: d.languageId, version: d.version, text: d.text } });
    }).catch((e) => {
      this.state = "failed";
      publishStatus();
      pushConsole({ kind: "info", text: `${this.name}: initialize failed: ${e}` });
    });
    return this.initialized;
  }

  request(method: string, params: Json, timeoutMs = 15000): Promise<Json> {
    const id = this.nextId++;
    const p = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${this.name} ${method} timed out`)); }, timeoutMs);
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
  await listen<{ server: ServerName; msg: Json }>("lsp-message", (e) => clients.get(e.payload.server)?.handle(e.payload.msg));
  await listen<{ server: ServerName; detail: string }>("lsp-exit", (e) => {
    const c = clients.get(e.payload.server);
    if (c) { c.state = "failed"; publishStatus(); }
    pushConsole({ kind: "info", text: `${e.payload.server} exited: ${e.payload.detail}` });
  });
  setInterval(() => invoke("lsp_check").catch(() => {}), 5000);
  registerProviders(monaco);
}

/** (Re)start servers for the current interpreter and working directory. */
export async function startLsp() {
  const python = get().python ?? "python3";
  const cwd = get().cwd ?? "/";
  const det = await invoke<{ pyright: string | null; ruff: string | null }>("detect_lsp", { python });
  for (const c of clients.values()) await invoke("lsp_stop", { name: c.name }).catch(() => {});
  clients.clear();
  const missing: string[] = [];
  if (det.pyright) clients.set("pyright", new LspClient("pyright", det.pyright, ["--stdio"]));
  else missing.push("basedpyright");
  if (det.ruff) clients.set("ruff", new LspClient("ruff", det.ruff, ["server"]));
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

// ------------------------------------------------------------ diagnostics --

function setDiagnostics(owner: string, uri: string, diags: Json[]) {
  const monaco = monacoRef;
  if (!monaco) return;
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

function registerProviders(monaco: typeof Monaco) {
  const py = () => { const c = clients.get("pyright"); return c && c.state === "running" ? c : null; };
  const ruff = () => { const c = clients.get("ruff"); return c && c.state === "running" ? c : null; };

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", "[", "\"", "'"],
    async provideCompletionItems(model, position) {
      const c = py();
      if (!c) return { suggestions: [] };
      const r = await c.request("textDocument/completion", { textDocument: { uri: model.uri.toString() }, position: pos(position) }).catch(() => null);
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
          // keep the raw item for resolve
          _lsp: it,
        } as Monaco.languages.CompletionItem)),
      };
    },
    async resolveCompletionItem(item) {
      const c = py();
      const raw = (item as any)._lsp;
      if (!c || !raw) return item;
      const r = await c.request("completionItem/resolve", raw).catch(() => null);
      if (r?.documentation) item.documentation = markdown(r.documentation)[0];
      if (r?.detail) item.detail = r.detail;
      return item;
    },
  });

  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/hover", { textDocument: { uri: model.uri.toString() }, position: pos(position) }).catch(() => null);
      if (!r?.contents) return null;
      return { contents: markdown(r.contents), range: r.range ? toRange(monaco, r.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/signatureHelp", { textDocument: { uri: model.uri.toString() }, position: pos(position) }).catch(() => null);
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
    async provideDefinition(model, position) {
      const c = py();
      if (!c) return null;
      const r = await c.request("textDocument/definition", { textDocument: { uri: model.uri.toString() }, position: pos(position) }).catch(() => null);
      if (!r) return null;
      const locs: Json[] = Array.isArray(r) ? r : [r];
      return locs.map((l) => ({ uri: monaco.Uri.parse(l.targetUri ?? l.uri), range: toRange(monaco, l.targetSelectionRange ?? l.targetRange ?? l.range) }));
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider("python", {
    async provideDocumentFormattingEdits(model) {
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
      import("./layout").then((l) => l.openFile(resource.path, line));
      return true;
    },
  });
}
