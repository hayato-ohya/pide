export type Mime = Record<string, unknown>;

export interface VarInfo {
  name: string;
  kind: "ndarray" | "dataframe" | "series" | "polars" | "tensor" | "jax" | "module" | "class" | "function" | "dict" | "sequence" | "text" | "scalar" | "object" | "model" | "image" | "xarray";
  type: string;
  module?: string;
  size: number;
  id?: number;
  shape?: number[];
  dtype?: string;
  device?: string;
  requires_grad?: boolean;
  columns?: string[];
  dims?: string[];
  params?: number;
  len?: number;
  value: string;
  stats?: { min?: number | string | null; max?: number | string | null; mean?: number | string | null; nan?: number; true?: number } | null;
}

export interface DetailWindow {
  path: string;
  kind: string;
  type: string;
  shape?: number[];
  dtype?: string;
  index?: number[];
  nrows: number;
  ncols: number;
  columns?: string[];
  dtypes?: string[];
  index_labels?: (string | number | null)[];
  rows: (string | number | boolean | null)[][];
  row0?: number;
  col0?: number;
  children?: VarInfo[];
  repr?: string;
  error?: string;
}

export type ConsoleItem =
  | { id: number; kind: "input"; code: string; count: number | null; msgId: string }
  | { id: number; kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { id: number; kind: "result"; data: Mime; count: number | null }
  | { id: number; kind: "display"; data: Mime; displayId?: string }
  | { id: number; kind: "error"; ename: string; evalue: string; traceback: string[] }
  | { id: number; kind: "info"; text: string };

export interface Figure {
  id: number;
  title: string;
  kind: "png" | "svg" | "html" | "plotly";
  data: unknown;
  layout?: unknown;
  displayId?: string;
}

export type KernelState = "stopped" | "starting" | "idle" | "busy" | "dead";

export interface KernelEvent {
  channel: "shell" | "iopub" | "control" | "stdin";
  msg_type: string;
  msg_id: string;
  parent_id: string | null;
  header: any;
  content: any;
  metadata: any;
}
