import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { fetchDetail } from "../kernel";
import { set, useStore } from "../store";
import ImageView from "./ImageView";
import type { DetailWindow } from "../types";
import { openVariable } from "../layout";

const ROW_H = 22;
const COL_W = 110;
const IDX_W = 70;
const BLOCK_R = 200;
const BLOCK_C = 50;
const MAX_BLOCKS = 48; // LRU cap on cached detail windows (~48 × 200 × 50 cells)

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : v.toPrecision(6).replace(/\.?0+$/, "");
  }
  return String(v);
}

/** Virtualized 2-D grid over a variable, fetching windows lazily. */
export default function VariableViewer(props: IDockviewPanelProps<{ path: string; mode?: "table" | "image" }>) {
  const path = props.params.path;
  const variables = useStore((s) => s.variables);
  const changedSet = useStore((s) => s.changed);
  const [meta, setMeta] = useState<DetailWindow | null>(null);
  const [index, setIndex] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [mode, setMode] = useState<"table" | "image">(props.params.mode ?? "table");
  const [selCols, setSelCols] = useState<number[]>([]);
  useEffect(() => {
    const d = props.api.onDidParametersChange((p: any) => { if (p?.mode) setMode(p.mode); });
    return () => d.dispose();
  }, []);
  const blocks = useRef(new Map<string, DetailWindow>());
  const inflight = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0, h: 400, w: 600 });

  const root = path.split(/[.\[]/)[0];
  const rootVar = variables.find((v) => v.name === root);
  const generation = `${rootVar?.id ?? ""}:${rootVar?.value ?? ""}:${(rootVar?.shape ?? []).join("x")}`;
  void changedSet;

  // (Re)load the first block whenever the variable changes.
  useEffect(() => {
    blocks.current.clear();
    setMeta(null);
    setError(null);
    let cancelled = false;
    fetchDetail(path, { row0: 0, row1: BLOCK_R, col0: 0, col1: BLOCK_C, index: index.length ? index : undefined })
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        setMeta(d);
        blocks.current.set("0:0", d);
        bump((x) => x + 1);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, index.join(","), generation, variables.length]);

  // Map insertion order doubles as LRU order: touch on read, evict oldest on insert.
  const getBlock = (key: string) => {
    const b = blocks.current.get(key);
    if (b) { blocks.current.delete(key); blocks.current.set(key, b); }
    return b;
  };
  const putBlock = (key: string, d: DetailWindow) => {
    blocks.current.delete(key);
    blocks.current.set(key, d);
    while (blocks.current.size > MAX_BLOCKS) {
      const oldest = blocks.current.keys().next().value as string;
      if (oldest === "0:0") { blocks.current.delete(oldest); blocks.current.set(oldest, blocks.current.get(oldest)!); continue; }
      blocks.current.delete(oldest);
    }
  };
  const ensure = (br: number, bc: number) => {
    const key = `${br}:${bc}`;
    if (blocks.current.has(key) || inflight.current.has(key)) return;
    inflight.current.add(key);
    fetchDetail(path, { row0: br * BLOCK_R, row1: (br + 1) * BLOCK_R, col0: bc * BLOCK_C, col1: (bc + 1) * BLOCK_C, index: index.length ? index : undefined })
      .then((d) => { putBlock(key, d); bump((x) => x + 1); })
      .catch((e) => setError(String(e)))
      .finally(() => inflight.current.delete(key));
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const imageable = !!meta && (["ndarray", "tensor", "jax", "xarray"].includes(meta.kind) || props.params.path.length > 0 && meta.type === "Image") && (meta.shape?.length ?? 0) >= 2;

  // Column selection → expression for the Plots tab (MATLAB variable editor style).
  const colExpr = (cols: number[]) => {
    if (!meta || !cols.length) return null;
    if (meta.kind === "dataframe" || meta.kind === "polars") {
      const names = cols.map((c) => colLabel(c));
      return names.length === 1 ? `${path}[${JSON.stringify(names[0])}]` : `${path}[[${names.map((n) => JSON.stringify(n)).join(", ")}]]`;
    }
    if (meta.kind === "series") return path;
    if (["ndarray", "tensor", "jax", "xarray"].includes(meta.kind)) {
      const lead = (meta.shape?.length ?? 0) > 2 ? `[${(index.length ? index : meta.index ?? []).join(", ")}]` : "";
      const n = meta.shape?.length ?? 1;
      if (n === 1) return path;
      return cols.length === 1 ? `${path}${lead}[:, ${cols[0]}]` : `${path}${lead}[:, [${cols.join(", ")}]]`;
    }
    return null;
  };
  const toggleCol = (c: number, additive: boolean) => {
    const next = additive ? (selCols.includes(c) ? selCols.filter((x) => x !== c) : [...selCols, c].sort((a, b) => a - b)) : [c];
    setSelCols(next);
    set({ plotExpr: colExpr(next), selectedVar: path.split(/[.\[]/)[0] });
  };

  if (error) return <div className="vv-error">{error}</div>;
  if (!meta) return <div className="vv-loading">Loading {path}…</div>;

  const nrows = meta.nrows ?? 0, ncols = meta.ncols ?? 0;
  const r0 = Math.max(0, Math.floor(scroll.top / ROW_H) - 5);
  const r1 = Math.min(nrows, Math.ceil((scroll.top + scroll.h) / ROW_H) + 5);
  const c0 = Math.max(0, Math.floor(scroll.left / COL_W) - 2);
  const c1 = Math.min(ncols, Math.ceil((scroll.left + scroll.w) / COL_W) + 2);
  for (let br = Math.floor(r0 / BLOCK_R); br <= Math.floor(Math.max(0, r1 - 1) / BLOCK_R); br++)
    for (let bc = Math.floor(c0 / BLOCK_C); bc <= Math.floor(Math.max(0, c1 - 1) / BLOCK_C); bc++) ensure(br, bc);

  const cellAt = (r: number, c: number) => {
    const b = getBlock(`${Math.floor(r / BLOCK_R)}:${Math.floor(c / BLOCK_C)}`);
    if (!b) return undefined;
    return b.rows[r - Math.floor(r / BLOCK_R) * BLOCK_R]?.[c - Math.floor(c / BLOCK_C) * BLOCK_C];
  };
  const colLabel = (c: number) => {
    const b = getBlock(`0:${Math.floor(c / BLOCK_C)}`) ?? getBlock(`${Math.floor(r0 / BLOCK_R)}:${Math.floor(c / BLOCK_C)}`);
    return b?.columns?.[c - Math.floor(c / BLOCK_C) * BLOCK_C] ?? String(c);
  };
  const rowLabel = (r: number) => {
    const b = getBlock(`${Math.floor(r / BLOCK_R)}:0`);
    return b?.index_labels?.[r - Math.floor(r / BLOCK_R) * BLOCK_R] ?? String(r);
  };
  const children = meta.children;
  const leadDims = meta.shape && meta.shape.length > 2 ? meta.shape.slice(0, -2) : [];

  const rowsEls = [];
  for (let r = r0; r < r1; r++) {
    const cells = [];
    for (let c = c0; c < c1; c++) {
      const v = cellAt(r, c);
      cells.push(
        <div key={c} className={`vv-cell ${typeof v === "number" ? "num" : ""} ${selCols.includes(c) ? "sel" : ""}`} style={{ left: IDX_W + c * COL_W, width: COL_W }}
             onDoubleClick={() => children && openVariable(`${path}${children[r - Math.floor(r / BLOCK_R) * BLOCK_R]?.name.startsWith("[") ? "" : "."}${children[r - Math.floor(r / BLOCK_R) * BLOCK_R]?.name ?? ""}`)}>
          {v === undefined ? "" : fmt(v)}
        </div>,
      );
    }
    rowsEls.push(
      <div key={r} className="vv-row" style={{ top: r * ROW_H, height: ROW_H }}>
        <div className="vv-cell vv-idx" style={{ left: 0, width: IDX_W }}>{String(rowLabel(r))}</div>
        {cells}
      </div>,
    );
  }

  return (
    <div className="vv">
      <div className="panel-toolbar">
        <span className="vv-title">{path}</span>
        <span className="muted">{meta.type}{meta.dtype ? ` · ${meta.dtype}` : ""}{meta.shape ? ` · ${meta.shape.join("×")}` : ` · ${nrows}×${ncols}`}</span>
        {leadDims.map((n, i) => (
          <label key={i} className="vv-dim">
            axis {i}: <input type="number" min={0} max={n - 1} value={index[i] ?? 0}
              onChange={(e) => { const ni = [...index]; while (ni.length < leadDims.length) ni.push(0); ni[i] = Math.max(0, Math.min(n - 1, +e.target.value)); setIndex(ni); }} />
            <span className="muted">/{n}</span>
          </label>
        ))}
        {meta.repr && <span className="muted vv-repr" title={meta.repr}>{meta.repr}</span>}
        {imageable && (
          <span className="vv-modes">
            <button className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}>Table</button>
            <button className={mode === "image" ? "on" : ""} onClick={() => setMode("image")}>Image</button>
          </span>
        )}
        {selCols.length > 0 && <span className="muted">{selCols.length} col selected → PLOTS tab</span>}
      </div>
      {mode === "image" ? <ImageView path={path} generation={generation} /> : <>
      <div className="vv-header" style={{ transform: `translateX(${-scroll.left}px)` }}>
        <div className="vv-cell vv-idx vv-corner" style={{ left: 0, width: IDX_W }} />
        {Array.from({ length: c1 - c0 }, (_, i) => c0 + i).map((c) => (
          <div key={c} className={`vv-cell vv-colh ${selCols.includes(c) ? "sel" : ""}`} style={{ left: IDX_W + c * COL_W, width: COL_W }} title="Click to select column (Cmd/Ctrl-click for several); then use the PLOTS tab" onClick={(e) => toggleCol(c, e.metaKey || e.ctrlKey)}>{colLabel(c)}</div>
        ))}
      </div>
      <div className="vv-scroll" ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft, h: e.currentTarget.clientHeight, w: e.currentTarget.clientWidth })}>
        <div className="vv-canvas" style={{ height: Math.max(1, nrows) * ROW_H, width: IDX_W + Math.max(1, ncols) * COL_W }}>{rowsEls}</div>
      </div>
      </>}
    </div>
  );
}
