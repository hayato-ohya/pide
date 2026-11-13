import { useEffect, useRef, useState } from "react";
import Plotly from "plotly.js-dist-min";
import { pushConsole, set, useStore } from "../store";
import { plotlyTheme } from "../theme";
import { safeHtml } from "../sanitize";
import { dockApi } from "../layout";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview";
import type { Figure } from "../types";

async function savePng(f: Figure, el: HTMLDivElement | null) {
  const path = await save({ defaultPath: `${f.title.replace(/[^\w.-]+/g, "_")}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!path) return;
  let b64: string;
  if (f.kind === "plotly" && el) b64 = (await Plotly.toImage(el, { format: "png", width: 1200, height: 800, scale: 2 })).split(",")[1];
  else if (f.kind === "png") b64 = String(f.data);
  else { pushConsole({ kind: "info", text: "Only plotly and PNG figures can be saved." }); return; }
  await invoke("write_binary_file", { path, b64 });
  pushConsole({ kind: "info", text: `Saved ${path}` });
}

export function Big({ f, logx, logy }: { f: Figure; logx?: boolean; logy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    if (f.kind === "plotly" && ref.current) {
      const base = (f.layout as any) ?? {};
      const t = plotlyTheme() as any;
      const layout = { ...t, ...base, xaxis: { ...t.xaxis, ...(base.xaxis ?? {}) }, yaxis: { ...t.yaxis, ...(base.yaxis ?? {}) }, autosize: true, margin: { t: 40, r: 20, b: 50, l: 60 }, }; layout.xaxis.type = logx ? "log" : layout.xaxis.type; layout.yaxis.type = logy ? "log" : layout.yaxis.type;
      Plotly.react(ref.current, f.data as any, layout, { responsive: true, displaylogo: false });
      const el = ref.current;
      const ro = new ResizeObserver(() => el && Plotly.Plots.resize(el));
      ro.observe(el);
      return () => { ro.disconnect(); try { Plotly.purge(el); } catch { /* already gone */ } };
    }
  }, [f, logx, logy, theme]);
  (Big as any).lastEl = ref;
  if (f.kind === "png") return <img className="fig-img" src={`data:image/png;base64,${f.data}`} />;
  if (f.kind === "svg") return <div className="fig-img" dangerouslySetInnerHTML={safeHtml(f.data)} />;
  if (f.kind === "html") return <div className="fig-img" dangerouslySetInnerHTML={safeHtml(f.data)} />;
  return <div className="fig-plotly" ref={ref} />;
}

/** A single figure in its own (floating) dock panel, like a MATLAB figure window. */
export function FigureWindow(props: IDockviewPanelProps<{ figId: number }>) {
  const f = useStore((s) => s.figures.find((x) => x.id === props.params.figId));
  if (!f) return <div className="muted center">Figure closed.</div>;
  return <div className="fig-view"><Big f={f} /></div>;
}

export default function Figures() {
  const figures = useStore((s) => s.figures);
  const active = useStore((s) => s.activeFigure);
  const [logx, setLogx] = useState(false);
  const [logy, setLogy] = useState(false);
  const bigRef = useRef<HTMLDivElement>(null);
  const f = figures.find((x) => x.id === active) ?? figures[figures.length - 1];
  const floatOut = () => {
    if (!f) return;
    const open = dockApi()?.getPanel(`fig:${f.id}`);
    if (open) { open.api.setActive(); return; } // already floating: a second panel with this id throws
    dockApi()?.addPanel({ id: `fig:${f.id}`, component: "figwindow", title: f.title, params: { figId: f.id }, floating: { width: 640, height: 480 } });
  };
  return (
    <div className="figures">
      <div className="fig-list">
        {figures.map((x) => (
          <div key={x.id} className={`fig-item ${x.id === f?.id ? "selected" : ""}`} onClick={() => set({ activeFigure: x.id })}>
            <span>{x.title}</span>
            <button title="Close" onClick={(e) => { e.stopPropagation(); set((s) => ({ figures: s.figures.filter((y) => y.id !== x.id) })); }}>×</button>
          </div>
        ))}
        {figures.length > 0 && <div className="fig-item clear" onClick={() => set({ figures: [], activeFigure: null })}>Clear all</div>}
      </div>
      <div className="fig-main">
        {f && (
          <div className="panel-toolbar">
            <span className="vv-title">{f.title}</span>
            {f.kind === "plotly" && <label><input type="checkbox" checked={logx} onChange={(e) => setLogx(e.target.checked)} /> log x</label>}
            {f.kind === "plotly" && <label><input type="checkbox" checked={logy} onChange={(e) => setLogy(e.target.checked)} /> log y</label>}
            <button onClick={floatOut} title="Open in a floating window">⧉ Float</button>
            <button onClick={() => savePng(f, bigRef.current?.querySelector(".fig-plotly") as HTMLDivElement | null)}>Save PNG…</button>
          </div>
        )}
        <div className="fig-view" ref={bigRef}>{f ? <Big f={f} logx={logx} logy={logy} /> : <div className="muted center">Figures from matplotlib, plotly and the PLOTS tab appear here.</div>}</div>
      </div>
    </div>
  );
}
