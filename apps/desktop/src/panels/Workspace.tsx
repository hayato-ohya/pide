import { useMemo, useState } from "react";
import { execute, refreshWorkspace } from "../kernel";
import { set, useStore } from "../store";
import type { VarInfo } from "../types";
import { openVariable, plotVariable } from "../layout";
import DebugVariables from "./DebugVariables";

const KIND_LABEL: Record<string, string> = {
  ndarray: "array", dataframe: "DataFrame", series: "Series", polars: "polars", tensor: "tensor", jax: "jax",
  model: "nn.Module", image: "Image", xarray: "DataArray", module: "module", class: "class", function: "function", dict: "dict", sequence: "list", text: "str", scalar: "", object: "",
};

function fmtBytes(n: number) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function fmtNum(v: number | string | null | undefined) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(3) : v.toFixed(4);
}
function sizeOf(v: VarInfo) {
  if (v.shape) return v.shape.length ? v.shape.join("×") : "scalar";
  if (v.len !== undefined && v.len !== null) return String(v.len);
  return "1×1";
}

type ColKey = "name" | "value" | "size" | "type" | "bytes" | "min" | "max" | "mean" | "nan";
const ALL_COLS: { key: ColKey; label: string; default: boolean }[] = [
  { key: "name", label: "Name", default: true },
  { key: "value", label: "Value", default: true },
  { key: "size", label: "Size", default: true },
  { key: "type", label: "Class", default: true },
  { key: "bytes", label: "Bytes", default: true },
  { key: "min", label: "Min", default: false },
  { key: "max", label: "Max", default: false },
  { key: "mean", label: "Mean", default: false },
  { key: "nan", label: "NaN", default: false },
];

function cell(v: VarInfo, k: ColKey): string {
  switch (k) {
    case "name": return v.name;
    case "value": return v.value;
    case "size": return sizeOf(v);
    case "type": return v.dtype ? `${v.type} (${v.dtype}${v.device ? ", " + v.device : ""}${v.requires_grad ? ", grad" : ""})` : v.type;
    case "bytes": return fmtBytes(v.size);
    case "min": return fmtNum(v.stats?.min);
    case "max": return fmtNum(v.stats?.max);
    case "mean": return fmtNum(v.stats?.mean);
    case "nan": return v.stats?.nan != null ? String(v.stats.nan) : "";
  }
}

export default function Workspace() {
  const variables = useStore((s) => s.variables);
  const changed = useStore((s) => s.changed);
  const selected = useStore((s) => s.selectedVar);
  const selectedVars = useStore((s) => s.selectedVars);
  const showHidden = useStore((s) => s.showHidden);
  const [filter, setFilter] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [cols, setCols] = useState<ColKey[]>(() => JSON.parse(localStorage.getItem("pide.wscols") ?? "null") ?? ALL_COLS.filter((c) => c.default).map((c) => c.key));
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [menu, setMenu] = useState<{ x: number; y: number; v: VarInfo } | null>(null);

  const debug = useStore((s) => s.debug);
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    let r = variables.filter((v) => (showCode || !["module", "function", "class"].includes(v.kind)) && (!f || v.name.toLowerCase().includes(f) || v.type.toLowerCase().includes(f)));
    r = r.slice().sort((a, b) => {
      if (sort.key === "bytes") return (a.size - b.size) * sort.dir;
      const x = cell(a, sort.key), y = cell(b, sort.key);
      const nx = parseFloat(x), ny = parseFloat(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * sort.dir;
      return x.localeCompare(y) * sort.dir;
    });
    return r;
  }, [variables, filter, showCode, sort]);

  const toggleCol = (k: ColKey) => {
    const next = cols.includes(k) ? cols.filter((c) => c !== k) : ALL_COLS.map((c) => c.key).filter((c) => c === k || cols.includes(c));
    setCols(next);
    localStorage.setItem("pide.wscols", JSON.stringify(next));
  };

  if (debug.stopped) return <DebugVariables />;
  return (
    <div className="workspace" onClick={() => setMenu(null)}>
      <div className="panel-toolbar">
        <input placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label title="Show modules, functions and classes"><input type="checkbox" checked={showCode} onChange={(e) => setShowCode(e.target.checked)} /> code</label>
        <label title="Show names starting with _"><input type="checkbox" checked={showHidden} onChange={(e) => { set({ showHidden: e.target.checked }); setTimeout(refreshWorkspace, 0); }} /> _hidden</label>
        <button onClick={() => refreshWorkspace()} title="Refresh">⟳</button>
        <span className="count">{rows.length}</span>
      </div>
      <div className="grid-wrap">
        <table className="grid ws-grid">
          <thead>
            <tr>
              {cols.map((k) => (
                <th key={k} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }))}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, v: null as any }); }}>
                  {ALL_COLS.find((c) => c.key === k)!.label}{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.name}
                  className={`${selected === v.name || selectedVars.includes(v.name) ? "selected" : ""} ${changed.has(v.name) ? "changed" : ""} kind-${v.kind}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      const list = selectedVars.includes(v.name) ? selectedVars.filter((n) => n !== v.name) : [...selectedVars, v.name];
                      set({ selectedVar: v.name, selectedVars: list, plotExpr: null });
                    } else if (e.shiftKey && selected) {
                      const names = rows.map((r) => r.name);
                      const a = names.indexOf(selected), b = names.indexOf(v.name);
                      set({ selectedVars: names.slice(Math.min(a, b), Math.max(a, b) + 1), plotExpr: null });
                    } else set({ selectedVar: v.name, selectedVars: [v.name], plotExpr: null });
                  }}
                  onDoubleClick={() => openVariable(v.name, v.kind === "image" ? "image" : "table")}
                  onContextMenu={(e) => { e.preventDefault(); set({ selectedVar: v.name }); setMenu({ x: e.clientX, y: e.clientY, v }); }}>
                {cols.map((k) => (
                  <td key={k} className={["bytes", "min", "max", "mean", "nan", "size"].includes(k) ? "num" : k === "name" ? "name" : ""} title={k === "value" ? v.value : undefined}>
                    {cell(v, k)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.v ? (
            <>
              <div onClick={() => openVariable(menu.v.name)}>Open in Variable Viewer</div>
              {["ndarray", "tensor", "jax", "xarray", "dataframe", "series", "polars", "sequence"].includes(menu.v.kind) && (
                <>
                  <div onClick={() => plotVariable(menu.v.name, "line")}>Plot (line)</div>
                  <div onClick={() => plotVariable(menu.v.name, "scatter")}>Scatter</div>
                  <div onClick={() => plotVariable(menu.v.name, "histogram")}>Histogram</div>
                  <div onClick={() => plotVariable(menu.v.name, "heatmap")}>Heatmap</div>
                  {["ndarray", "tensor", "jax", "xarray", "image"].includes(menu.v.kind) && (menu.v.shape?.length ?? 0) >= 2 && <div onClick={() => openVariable(menu.v.name, "image")}>View as image</div>}
                </>
              )}
              <div onClick={() => execute(`print(${menu.v.name})`)}>Print</div>
              <div onClick={() => execute(`del ${menu.v.name}`)}>Delete</div>
            </>
          ) : (
            ALL_COLS.map((c) => (
              <div key={c.key} onClick={(e) => { e.stopPropagation(); toggleCol(c.key); }}>
                {cols.includes(c.key) ? "☑" : "☐"} {c.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
