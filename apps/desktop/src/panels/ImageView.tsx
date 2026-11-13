import { useEffect, useMemo, useRef, useState } from "react";
import { fetchImage, type ImageData_ } from "../kernel";

// Small colormaps sampled at 8 stops; interpolated to 256 entries.
const STOPS: Record<string, [number, number, number][]> = {
  viridis: [[68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],[31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37]],
  magma: [[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,194,135],[252,253,191],[252,253,191]],
  gray: [[0,0,0],[255,255,255]],
  jet: [[0,0,131],[0,60,170],[5,255,255],[255,255,0],[250,0,0],[128,0,0]],
  coolwarm: [[59,76,192],[141,176,254],[221,221,221],[245,156,125],[180,4,38]],
  hot: [[10,0,0],[180,0,0],[255,130,0],[255,255,60],[255,255,255]],
};
function lut(name: string): Uint8ClampedArray {
  const stops = STOPS[name] ?? STOPS.viridis;
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[a][c] * (1 - f) + stops[b][c] * f;
  }
  return out;
}

/** Canvas image viewer for 2-D / RGB arrays with colormap, range and zoom. */
export default function ImageView({ path, generation }: { path: string; generation: string | number }) {
  const [img, setImg] = useState<ImageData_ | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cmap, setCmap] = useState("viridis");
  const [layout, setLayout] = useState("auto");
  const [index, setIndex] = useState<number[]>([]);
  // `rangeDraft` follows the inputs; `range` (what is fetched) follows 300 ms after typing
  // stops, so a full image is not rendered and transferred for every keystroke.
  const [range, setRange] = useState<{ vmin: string; vmax: string }>({ vmin: "", vmax: "" });
  const [rangeDraft, setRangeDraft] = useState(range);
  useEffect(() => {
    const t = setTimeout(() => setRange((r) => (r.vmin === rangeDraft.vmin && r.vmax === rangeDraft.vmax ? r : rangeDraft)), 300);
    return () => clearTimeout(t);
  }, [rangeDraft.vmin, rangeDraft.vmax]);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [hover, setHover] = useState<string>("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [wrapSize, setWrapSize] = useState({ w: 600, h: 400 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setWrapSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setError(null);
    let cancelled = false;
    const vmin = range.vmin === "" ? null : Number(range.vmin);
    const vmax = range.vmax === "" ? null : Number(range.vmax);
    fetchImage(path, { index: index.length ? index : undefined, vmin, vmax, layout })
      .then((d) => { if (!cancelled) (d.error ? setError(d.error) : setImg(d)); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, generation, index.join(","), range.vmin, range.vmax, layout]);

  const bytes = useMemo(() => (img ? Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0)) : null), [img]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !bytes) return;
    c.width = img.w;
    c.height = img.h;
    const ctx = c.getContext("2d")!;
    const out = ctx.createImageData(img.w, img.h);
    const n = img.w * img.h;
    if (img.channels === 3) {
      for (let i = 0; i < n; i++) {
        out.data[i * 4] = bytes[i * 3];
        out.data[i * 4 + 1] = bytes[i * 3 + 1];
        out.data[i * 4 + 2] = bytes[i * 3 + 2];
        out.data[i * 4 + 3] = 255;
      }
    } else {
      const L = lut(cmap);
      for (let i = 0; i < n; i++) {
        const v = bytes[i];
        out.data[i * 4] = L[v * 3];
        out.data[i * 4 + 1] = L[v * 3 + 1];
        out.data[i * 4 + 2] = L[v * 3 + 2];
        out.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
  }, [img, bytes, cmap, error]);

  const scale = useMemo(() => {
    if (!img || zoom !== "fit") return typeof zoom === "number" ? zoom : 1;
    return Math.max(0.05, Math.min((wrapSize.w - 20) / img.w, (wrapSize.h - 20) / img.h));
  }, [img, zoom, wrapSize]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!img || !bytes) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * img.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * img.h);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const i = y * img.w + x;
    const s = img.step;
    const approx = (b: number) => (img.vmin + (b / 255) * (img.vmax - img.vmin)).toPrecision(4);
    const val = img.channels === 3 ? `rgb≈(${approx(bytes[i * 3])}, ${approx(bytes[i * 3 + 1])}, ${approx(bytes[i * 3 + 2])})` : `≈${approx(bytes[i])}`;
    setHover(`[${y * s}, ${x * s}] ${val}`);
  };

  const layoutSel = <label>layout <select value={layout} onChange={(e) => { setLayout(e.target.value); setIndex([]); }}><option value="auto">auto</option><option value="HW">HW</option><option value="HWC">HWC</option><option value="CHW">CHW</option></select></label>;
  return (
    <div className="imgview">
      <div className="panel-toolbar">
        {img && <span className="muted">{img.shape.join("×")} {img.dtype} · {img.layout}{img.step > 1 ? ` · ↓${img.step}` : ""}</span>}
        {layoutSel}
        {img && img.channels === 1 && <label>cmap <select value={cmap} onChange={(e) => setCmap(e.target.value)}>{Object.keys(STOPS).map((k) => <option key={k}>{k}</option>)}</select></label>}
        <label>min <input className="small" value={rangeDraft.vmin} placeholder={img ? img.vmin.toPrecision(4) : ""} onChange={(e) => setRangeDraft({ ...rangeDraft, vmin: e.target.value })} /></label>
        <label>max <input className="small" value={rangeDraft.vmax} placeholder={img ? img.vmax.toPrecision(4) : ""} onChange={(e) => setRangeDraft({ ...rangeDraft, vmax: e.target.value })} /></label>
        <label>zoom <select value={String(zoom)} onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}><option value="fit">fit</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select></label>
        {img?.extra.map((n, i) => (
          <label key={i} className="vv-dim">axis {i}: <input type="number" min={0} max={n - 1} value={index[i] ?? 0} onChange={(e) => { const ni = [...index]; while (ni.length < img.extra.length) ni.push(0); ni[i] = Math.max(0, Math.min(n - 1, +e.target.value)); setIndex(ni); }} /><span className="muted">/{n}</span></label>
        ))}
        <span className="muted hover">{hover}</span>
      </div>
      <div className="imgview-wrap" ref={wrap}>
        {error ? <div className="vv-error">{error}</div>
          : !img ? <div className="vv-loading">Rendering {path}…</div>
          : <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setHover("")} style={{ width: img.w * scale, height: img.h * scale, imageRendering: scale >= 2 ? "pixelated" : "auto" }} />}
      </div>
    </div>
  );
}
