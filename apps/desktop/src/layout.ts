// Dockview helpers shared by panels (open files / variables / plots).
import type { DockviewApi } from "dockview";
import { get } from "./store";

let api: DockviewApi | null = null;
export function setDockApi(a: DockviewApi) {
  api = a;
}
export function dockApi() {
  return api;
}

export const LAYOUT_KEY = "pide.layout.v1";

/** MATLAB default: files left, editor+console centre, workspace+history right. */
export function buildDefaultLayout(a: DockviewApi) {
  a.clear();
  const editor = a.addPanel({ id: "editor:untitled", component: "editor", title: "untitled.py", params: { path: null } });
  a.addPanel({ id: "figures", component: "figures", title: "Figures", position: { referencePanel: editor, direction: "within" }, inactive: true });
  const console_ = a.addPanel({ id: "console", component: "console", title: "Command Window", position: { referencePanel: editor, direction: "below" }, initialHeight: 320 });
  a.addPanel({ id: "terminal", component: "terminal", title: "Terminal", position: { referencePanel: console_, direction: "within" }, inactive: true });
  const files = a.addPanel({ id: "files", component: "files", title: "Current Folder", position: { referencePanel: editor, direction: "left" }, initialWidth: 280 });
  a.addPanel({ id: "git", component: "git", title: "Git", position: { referencePanel: files, direction: "within" }, inactive: true });
  const ws = a.addPanel({ id: "workspace", component: "workspace", title: "Workspace", position: { referencePanel: editor, direction: "right" }, initialWidth: 460 });
  const hist = a.addPanel({ id: "history", component: "history", title: "Command History", position: { referencePanel: ws, direction: "below" }, initialHeight: 220 });
  a.addPanel({ id: "debugger", component: "debugger", title: "Debugger", position: { referencePanel: hist, direction: "within" }, inactive: true });
  editor.api.setActive();
}

export const revealRequests = new Map<string, number>();
export function openNotebook(path: string | null) {
  if (!api) return;
  const id = path ? `nb:${path}` : `nb:untitled-${Date.now()}`;
  const existing = api.getPanel(id);
  if (existing) { existing.api.setActive(); return; }
  const ref = api.panels.find((p) => p.id.startsWith("nb:") || p.id.startsWith("editor:"));
  api.addPanel({ id, component: "notebook", title: path ? path.split("/").pop() : "untitled.ipynb", params: { path }, position: ref ? { referencePanel: ref, direction: "within" } : undefined });
}

export function openFile(path: string, line?: number) {
  if (!api) return;
  if (path.endsWith(".ipynb")) { openNotebook(path); return; }
  const id = `editor:${path}`;
  if (line) revealRequests.set(path, line);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    existing.api.updateParameters({ path, reveal: line ?? null, revealTick: Date.now() });
    return;
  }
  const ref = api.panels.find((p) => p.id.startsWith("editor:")) ?? api.getPanel("figures");
  api.addPanel({
    id,
    component: "editor",
    title: path.split("/").pop(),
    params: { path, reveal: line ?? null },
    position: ref ? { referencePanel: ref, direction: "within" } : undefined,
  });
}

/** Open (or focus) the editor for a path/uri and move the cursor to a line. */
export function revealInEditor(uri: string, line: number) {
  if (!api) return;
  if (uri.startsWith("vscode-notebook-cell:")) {
    const u = new URL(uri);
    const nbPath = decodeURIComponent(u.pathname);
    const cellId = u.hash.slice(1);
    const p = api.getPanel(`nb:${nbPath}`);
    if (p) { p.api.setActive(); p.api.updateParameters({ ...p.params, reveal: { cellId, line, tick: Date.now() } }); }
    return;
  }
  if (uri.startsWith("untitled:")) {
    const p = api.panels.find((p) => p.id.startsWith("editor:") && (p.params as any)?.uri === uri);
    if (p) { p.api.setActive(); p.api.updateParameters({ ...p.params, reveal: line, revealTick: Date.now() }); }
    return;
  }
  const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
  openFile(path, line);
}

export function openDiff(diff: import("./git").FileDiff, label: string) {
  if (!api) return;
  const id = `diff:${label}:${diff.path}`;
  const existing = api.getPanel(id);
  if (existing) { existing.api.updateParameters({ diff, label }); existing.api.setActive(); return; }
  const ref = api.panels.find((p) => p.id.startsWith("diff:")) ?? api.panels.find((p) => p.id.startsWith("editor:"));
  api.addPanel({ id, component: "diff", title: diff.path.split("/").pop(), params: { diff, label }, position: ref ? { referencePanel: ref, direction: "within" } : undefined });
}

export function openVariable(path: string, mode: "table" | "image" = "table") {
  if (!api) return;
  const id = `var:${path}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    existing.api.updateParameters({ path, mode });
    return;
  }
  const ref = api.panels.find((p) => p.id.startsWith("var:")) ?? api.panels.find((p) => p.id.startsWith("editor:"));
  api.addPanel({
    id,
    component: "variable",
    title: path,
    params: { path, mode },
    position: ref ? { referencePanel: ref, direction: "within" } : undefined,
  });
}

export type { PlotKind } from "./plots";
export async function plotVariable(name: string, kind: import("./plots").PlotKind) {
  const { plotExprs } = await import("./plots");
  return plotExprs([name], kind);
}

export function selectedVariable() {
  return get().selectedVar;
}
