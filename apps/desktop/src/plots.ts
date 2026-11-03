// Plot builders shared by the Plots tab, Workspace context menu and viewers.
import { fetchPlotExpr } from "./kernel";
import { addFigure, pushConsole } from "./store";
import { dockApi } from "./layout";

export type PlotKind = "line" | "scatter" | "bar" | "histogram" | "heatmap" | "subplots";

interface Series { name: string; y: number[]; x?: number[] }

/** Flatten plot_expr results into named series (1-D → one, 2-D → one per column). */
function toSeries(expr: string, d: any): Series[] {
  if (d.y) return [{ name: expr, y: d.y, x: d.y.map((_: unknown, i: number) => i * (d.step ?? 1)) }];
  if (d.z) {
    const z: number[][] = d.z;
    const ncol = z[0]?.length ?? 0;
    const cols = d.columns ?? Array.from({ length: ncol }, (_, i) => `${expr}[:, ${i}]`);
    return Array.from({ length: ncol }, (_, c) => ({ name: String(cols[c]), y: z.map((r) => r[c]) }));
  }
  return [];
}

/** Plot one or more expressions on shared axes, or as a grid of subplots. */
export async function plotExprs(exprs: string[], kind: PlotKind) {
  if (!exprs.length) return;
  try {
    const results = await Promise.all(exprs.map((e) => fetchPlotExpr(e)));
    const err = results.find((r) => r.error);
    if (err) {
      pushConsole({ kind: "info", text: `${err.path}: ${err.error}` });
      return;
    }
    const title = exprs.join(", ");
    let data: any[] = [];
    let layout: any = { title: { text: title }, showlegend: true };

    if (kind === "heatmap") {
      const d = results[0];
      const z = d.z ?? [d.y];
      data = [{ type: "heatmap", z, colorscale: "Viridis" }];
      layout.yaxis = { autorange: "reversed", scaleanchor: "x" };
      layout.showlegend = false;
    } else {
      const series = results.flatMap((r, i) => toSeries(exprs[i], r));
      if (kind === "subplots") {
        const n = series.length;
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        data = series.map((s, i) => ({ type: "scatter", mode: "lines", name: s.name, x: s.x, y: s.y, xaxis: i ? `x${i + 1}` : "x", yaxis: i ? `y${i + 1}` : "y" }));
        layout.grid = { rows, columns: cols, pattern: "independent" };
        layout.annotations = series.map((s, i) => ({ text: s.name, showarrow: false, xref: `x${i ? i + 1 : ""} domain`, yref: `y${i ? i + 1 : ""} domain`, x: 0.5, y: 1.08, font: { size: 11 } }));
        layout.showlegend = false;
      } else if (kind === "histogram") {
        data = series.map((s) => ({ type: "histogram", x: s.y, name: s.name, opacity: series.length > 1 ? 0.6 : 1 }));
        if (series.length > 1) layout.barmode = "overlay";
      } else if (kind === "bar") {
        data = series.map((s) => ({ type: "bar", x: s.x, y: s.y, name: s.name }));
      } else {
        data = series.map((s) => ({ type: "scatter", mode: kind === "scatter" ? "markers" : "lines", x: s.x, y: s.y, name: s.name, marker: { size: 5 } }));
      }
    }
    addFigure({ title: `${title} (${kind})`, kind: "plotly", data, layout });
    dockApi()?.getPanel("figures")?.api.setActive();
  } catch (e) {
    pushConsole({ kind: "info", text: `plot failed: ${e}` });
  }
}
