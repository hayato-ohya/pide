import { useEffect, useRef, useState } from "react";
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, themeLight, themeDark } from "dockview";
import { applyTheme } from "./theme";
import { open } from "@tauri-apps/plugin-dialog";
import Console from "./panels/Console";
import Workspace from "./panels/Workspace";
import VariableViewer from "./panels/VariableViewer";
import Figures, { FigureWindow } from "./panels/Figures";
import Files from "./panels/Files";
import History from "./panels/History";
import Git from "./panels/Git";
import DiffView from "./panels/DiffView";
import Debugger from "./panels/Debugger";
import RemoteDialog from "./panels/RemoteDialog";
import NotebookPanel from "./panels/Notebook";
import BreakpointDialog from "./panels/BreakpointDialog";
import { setExceptionFilters } from "./debug";
import { cont, stepIn, stepOut, stepOver, stopDebugger } from "./debug";
import EditorPanel, { activeEditorId, editors } from "./panels/Editor";
import { complete, initKernelBridge, interrupt, restartKernel, setPython, startKernel } from "./kernel";
import { buildDefaultLayout, dockApi, LAYOUT_KEY, openFile, openNotebook, openVariable, plotVariable, setDockApi, type PlotKind } from "./layout";
import { get, pushConsole, set, useStore } from "./store";

const components = {
  console: Console,
  workspace: Workspace,
  variable: VariableViewer,
  figures: Figures,
  figwindow: FigureWindow,
  files: Files,
  history: History,
  git: Git,
  diff: DiffView,
  debugger: Debugger,
  notebook: NotebookPanel,
  editor: EditorPanel,
};

// Dev handle for scripted UI checks (PIDE_DEV_SCRIPT).
(window as any).pide = { setBreakpoint: (u: string, l: number, p: any) => import("./debug").then((d) => d.setBreakpoint(u, l, p)), formatDocument: (u: string, t: string) => import("./lsp").then((l) => l.formatDocument(u, t)), execute: (c: string) => import("./kernel").then((k) => k.execute(c)), setRemote: (r: any) => import("./kernel").then((k) => k.setRemote(r)), restartKernel, openFile, openVariable, plotVariable, dockApi, set, complete, pushConsole, isStopped: () => get().debug.stopped, state: () => get(), debug: () => import("./debug"), plotExprs: (e: string[], k: PlotKind) => import("./plots").then((p) => p.plotExprs(e, k)) };

const STATE_LABEL: Record<string, string> = { stopped: "Kernel stopped", starting: "Starting kernel…", idle: "Ready", busy: "Busy", dead: "Kernel died" };

export default function App() {
  const kernel = useStore((s) => s.kernel);
  const python = useStore((s) => s.python);
  const pythons = useStore((s) => s.pythons);
  const cwd = useStore((s) => s.cwd);
  const selectedVar = useStore((s) => s.selectedVar);
  const selectedVars = useStore((s) => s.selectedVars);
  const plotExpr = useStore((s) => s.plotExpr);
  const detail = useStore((s) => s.kernelDetail);
  const lsp = useStore((s) => s.lsp);
  const [tab, setTab] = useState<"home" | "plots" | "editor" | "debug" | "view">("home");
  const debug = useStore((s) => s.debug);
  const remote = useStore((s) => s.remote);
  const theme = useStore((s) => s.theme);
  const themePref = useStore((s) => s.themePref);
  const connectionFile = useStore((s) => s.connectionFile);
  const [remoteDlg, setRemoteDlg] = useState(false);
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    initKernelBridge().then(startKernel);
    const t = setInterval(() => import("./git").then((g) => g.refreshGit()), 4000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" && !e.shiftKey && (window as any).pide?.isStopped?.()) { e.preventDefault(); e.stopPropagation(); cont(); }
      else if (e.key === "F10") { e.preventDefault(); stepOver(); }
      else if (e.key === "F11" && e.shiftKey) { e.preventDefault(); stepOut(); }
      else if (e.key === "F11") { e.preventDefault(); stepIn(); }
      else if (e.key === "F5" && e.shiftKey) { e.preventDefault(); stopDebugger(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, []);

  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    setDockApi(e.api);
    const saved = localStorage.getItem(LAYOUT_KEY);
    let ok = false;
    if (saved) {
      try {
        e.api.fromJSON(JSON.parse(saved));
        // Figures live only in memory, so their floating windows cannot be restored.
        for (const p of [...e.api.panels]) if (p.id.startsWith("fig:") || p.id.startsWith("diff:")) e.api.removePanel(p);
        ok = e.api.panels.length > 0;
        // Panels introduced after the layout was saved: add them next to their siblings.
        if (ok && !e.api.getPanel("debugger")) {
          const hist = e.api.getPanel("history");
          e.api.addPanel({ id: "debugger", component: "debugger", title: "Debugger", position: hist ? { referencePanel: hist, direction: "within" } : undefined, inactive: true });
        }
        if (ok && !e.api.getPanel("git")) {
          const files = e.api.getPanel("files");
          e.api.addPanel({ id: "git", component: "git", title: "Git", position: files ? { referencePanel: files, direction: "within" } : undefined, inactive: true });
        }
      } catch {
        ok = false;
      }
    }
    if (!ok) buildDefaultLayout(e.api);
    e.api.onDidLayoutChange(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())));
  };

  const showPanel = (id: string, component: string, title: string) => {
    const a = apiRef.current!;
    const p = a.getPanel(id);
    if (p) p.api.setActive();
    else a.addPanel({ id, component, title, floating: { width: 500, height: 400 } });
  };

  const openDialog = async () => {
    const p = await open({ multiple: false, filters: [{ name: "Python / notebook / text", extensions: ["py", "ipynb", "txt", "md", "json", "toml", "yaml", "csv"] }] });
    if (typeof p === "string") openFile(p);
  };
  const newScript = () => {
    const a = apiRef.current!;
    const id = `editor:untitled-${Date.now()}`;
    const ref = a.panels.find((p) => p.id.startsWith("editor:"));
    a.addPanel({ id, component: "editor", title: "untitled.py", params: { path: null }, position: ref ? { referencePanel: ref, direction: "within" } : undefined });
  };
  const active = () => (activeEditorId && editors.get(activeEditorId)) || null;

  const plotTargets = plotExpr ? [plotExpr] : selectedVars.length ? selectedVars : selectedVar ? [selectedVar] : [];
  const plotBtn = (kind: PlotKind, label: string) => (
    <button disabled={!plotTargets.length} onClick={() => import("./plots").then((p) => p.plotExprs(plotTargets, kind))}>{label}</button>
  );

  return (
    <div className="app">
      <div className="toolstrip">
        <div className="ts-tabs">
          {(["home", "plots", "editor", "debug", "view"] as const).map((t) => (
            <div key={t} className={`ts-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t.toUpperCase()}</div>
          ))}
          <div className="ts-title">Pide</div>
        </div>
        <div className="ts-body">
          {tab === "home" && (
            <>
              <div className="ts-group"><div className="ts-row"><button onClick={newScript}>＋ New Script</button><button onClick={() => openNotebook(null)}>＋ New Notebook</button><button onClick={openDialog}>Open…</button><button onClick={() => active()?.save()}>Save</button></div><div className="ts-label">FILE</div></div>
              <div className="ts-group"><div className="ts-row"><button className="primary" onClick={() => active()?.run()} title="F5">▶ Run</button><button onClick={() => active()?.runCell()} title="Ctrl+Enter">Run Section</button></div><div className="ts-label">RUN</div></div>
              <div className="ts-group"><div className="ts-row"><button onClick={interrupt} disabled={kernel !== "busy"}>⏹ Interrupt</button><button onClick={restartKernel}>⟳ Restart</button><button onClick={() => set({ console: [] })}>Clear Console</button></div><div className="ts-label">KERNEL</div></div>
              <div className="ts-group"><div className="ts-row">
                <select value={remote ? "__remote__" : connectionFile ? "__file__" : python ?? ""} onChange={(e) => { if (e.target.value === "__remote__") setRemoteDlg(true); else setPython(e.target.value); }} title="Python interpreter (restart kernel to apply)">
                  {pythons.map((p) => <option key={p} value={p}>{p}</option>)}
                  {remote && <option value="__remote__">ssh: {remote.host} · {remote.python}</option>}
                  {!remote && <option value="__remote__">Remote kernel (SSH)…</option>}
                  {connectionFile && <option value="__file__">{connectionFile}</option>}
                </select>
                <button onClick={() => setRemoteDlg(true)} title="Remote kernel settings">⇄</button></div><div className="ts-label">ENVIRONMENT</div></div>
            </>
          )}
          {tab === "plots" && (
            <>
              <div className="ts-group"><div className="ts-row"><span className="muted sel-expr" title={plotTargets.join(", ")}>{plotTargets.length ? plotTargets.join(", ") : "Select variables in Workspace (Cmd-click for several) or columns in a Variable Viewer"}</span></div><div className="ts-label">SELECTION</div></div>
              <div className="ts-group"><div className="ts-row">{plotBtn("line", "plot")}{plotBtn("scatter", "scatter")}{plotBtn("bar", "bar")}{plotBtn("histogram", "histogram")}{plotBtn("heatmap", "imagesc")}{plotBtn("subplots", "subplots")}</div><div className="ts-label">PLOTS</div></div>
              <div className="ts-group"><div className="ts-row"><button disabled={!selectedVar} onClick={() => selectedVar && openVariable(selectedVar, "image")}>image viewer</button></div><div className="ts-label">VIEW</div></div>
            </>
          )}
          {tab === "editor" && (
            <div className="ts-group"><div className="ts-row"><button onClick={() => active()?.run()}>▶ Run (F5)</button><button onClick={() => active()?.runCell()}>Run Section (Ctrl+Enter)</button><button onClick={() => active()?.save()}>Save (Ctrl+S)</button><button onClick={() => active()?.format()} title="ruff format">Format (Shift+Alt+F)</button></div><div className="ts-label">EDITOR</div></div>
          )}
          {tab === "debug" && (
            <>
              <div className="ts-group"><div className="ts-row"><button className="primary" onClick={() => active()?.debug()} title="Save and run the file under the debugger">🐞 Debug File</button><button onClick={() => active()?.debugCell()}>Debug Cell</button></div><div className="ts-label">RUN</div></div>
              <div className="ts-group"><div className="ts-row"><button disabled={!debug.stopped} onClick={cont} title="F5">▶ Continue</button><button disabled={!debug.stopped} onClick={stepOver} title="F10">⤼ Step</button><button disabled={!debug.stopped} onClick={stepIn} title="F11">⤵ Step In</button><button disabled={!debug.stopped} onClick={stepOut} title="Shift+F11">⤴ Step Out</button><button disabled={!debug.active} onClick={stopDebugger}>■ Quit Debugging</button></div><div className="ts-label">{debug.active ? (debug.stopped ? `STOPPED · ${debug.reason}` : "DEBUGGING") : "DEBUG"}</div></div>
              <div className="ts-group"><div className="ts-row">
                <label className="ts-check"><input type="checkbox" checked={debug.exceptions.uncaught} onChange={(e) => setExceptionFilters({ ...debug.exceptions, uncaught: e.target.checked })} /> Uncaught</label>
                <label className="ts-check"><input type="checkbox" checked={debug.exceptions.raised} onChange={(e) => setExceptionFilters({ ...debug.exceptions, raised: e.target.checked })} /> Raised</label>
              </div><div className="ts-label">BREAK ON EXCEPTION</div></div>
              <div className="ts-group"><div className="ts-row"><button onClick={() => showPanel("debugger", "debugger", "Debugger")}>Call Stack / Breakpoints</button><span className="muted">Click the gutter for a breakpoint, right-click for a condition / logpoint</span></div><div className="ts-label">VIEW</div></div>
            </>
          )}
          {tab === "view" && (
            <>
              <div className="ts-group"><div className="ts-row">
                <button onClick={() => showPanel("console", "console", "Command Window")}>Command Window</button>
                <button onClick={() => showPanel("workspace", "workspace", "Workspace")}>Workspace</button>
                <button onClick={() => showPanel("files", "files", "Current Folder")}>Current Folder</button>
                <button onClick={() => showPanel("history", "history", "Command History")}>Command History</button>
                <button onClick={() => showPanel("git", "git", "Git")}>Git</button>
                <button onClick={() => showPanel("debugger", "debugger", "Debugger")}>Debugger</button>
                <button onClick={() => showPanel("figures", "figures", "Figures")}>Figures</button>
              </div><div className="ts-label">PANELS</div></div>
              <div className="ts-group"><div className="ts-row"><button onClick={() => apiRef.current && buildDefaultLayout(apiRef.current)}>Default Layout</button></div><div className="ts-label">LAYOUT</div></div>
              <div className="ts-group"><div className="ts-row">
                {(["light", "dark", "system"] as const).map((t) => <button key={t} className={themePref === t ? "primary" : ""} onClick={() => applyTheme(t)}>{t === "light" ? "☀ Light" : t === "dark" ? "☾ Dark" : "⟳ System"}</button>)}
              </div><div className="ts-label">THEME</div></div>
            </>
          )}
        </div>
      </div>
      {remoteDlg && <RemoteDialog onClose={() => setRemoteDlg(false)} />}
      <BreakpointDialog />
      <div className="dock">
        <DockviewReact components={components} onReady={onReady} theme={theme === "dark" ? themeDark : themeLight} />
      </div>
      <div className={`statusbar ${kernel}`}>
        <span className="dot" />
        <span>{STATE_LABEL[kernel] ?? kernel}{detail ? ` (${detail})` : ""}</span>
        <span className="sep">|</span>
        <span title="interpreter">{remote ? `ssh ${remote.host} · ${remote.python}` : connectionFile ? `attached · ${connectionFile.split("/").pop()}` : python}</span>
        <span className="sep">|</span>
        <span title="working directory">{cwd}</span>
        <span className="right">
          {Object.entries(lsp).map(([k, v]) => <span key={k} className={`lsp ${v}`} title={`${k}: ${v}`}>{k}</span>)}
        </span>
      </div>
    </div>
  );
}
