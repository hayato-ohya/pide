"""pide_kernel: runs inside an ipykernel and exposes the user namespace to the IDE.

Everything here is invoked through Jupyter ``user_expressions`` so that it rides
on the normal execute_request/execute_reply round trip.  Results are returned as
objects with ``_repr_mimebundle_`` so IPython forwards a JSON object (not a
string) under our own mime type.
"""
from __future__ import annotations

import inspect
import math
import sys
import types

MIME = "application/x-pide+json"

HIDDEN_PREFIXES = ("_",)
IPY_NAMES = {"In", "Out", "get_ipython", "exit", "quit", "open"}


class _Payload:
    def __init__(self, data):
        self.data = data

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {MIME: self.data}


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------

def _mod(obj):
    return type(obj).__module__.split(".")[0]


def _is_numpy(obj):
    return _mod(obj) == "numpy" and hasattr(obj, "shape") and hasattr(obj, "dtype")


def _is_pandas_df(obj):
    return _mod(obj) == "pandas" and type(obj).__name__ == "DataFrame"


def _is_pandas_series(obj):
    return _mod(obj) == "pandas" and type(obj).__name__ == "Series"


def _is_polars_df(obj):
    return _mod(obj) == "polars" and type(obj).__name__ == "DataFrame"


def _is_torch(obj):
    return _mod(obj) == "torch" and type(obj).__name__ in ("Tensor", "Parameter")


def _is_nn_module(obj):
    if _mod(obj) != "torch" and not _mod(obj).startswith("torch"):
        try:
            import torch.nn as nn  # noqa: F401
        except Exception:
            return False
    try:
        import torch
        return isinstance(obj, torch.nn.Module)
    except Exception:
        return False


def _is_polars_series(obj):
    return _mod(obj) == "polars" and type(obj).__name__ == "Series"


def _is_xarray(obj):
    return _mod(obj) == "xarray" and type(obj).__name__ in ("DataArray", "Variable")


def _is_pil(obj):
    return _mod(obj) == "PIL" and hasattr(obj, "size") and hasattr(obj, "mode")


def _is_jax(obj):
    return _mod(obj) in ("jaxlib", "jax") and hasattr(obj, "shape") and hasattr(obj, "dtype")


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _finite(x):
    try:
        f = float(x)
    except Exception:
        return None
    if math.isnan(f) or math.isinf(f):
        return str(f)
    return f


def _nbytes(obj):
    if _is_numpy(obj):
        return int(obj.nbytes)
    if _is_pandas_df(obj) or _is_pandas_series(obj):
        return int(_safe(lambda: obj.memory_usage(deep=False).sum() if _is_pandas_df(obj) else obj.memory_usage(deep=False), 0))
    if _is_polars_df(obj) or _is_polars_series(obj):
        return int(_safe(lambda: obj.estimated_size(), 0))
    if _is_xarray(obj):
        return int(_safe(lambda: obj.nbytes, 0))
    if _is_nn_module(obj):
        return int(_safe(lambda: sum(p.numel() * p.element_size() for p in obj.parameters()), 0))
    if _is_torch(obj):
        return int(_safe(lambda: obj.element_size() * obj.nelement(), 0))
    if _is_jax(obj):
        return int(_safe(lambda: obj.nbytes, 0))
    return _safe(lambda: sys.getsizeof(obj), 0)


def _array_stats(arr):
    """min/max/mean/nan count for a numeric numpy array (cheap, capped)."""
    try:
        import numpy as np
        if arr.size == 0 or arr.size > 50_000_000:
            return None
        if arr.dtype.kind in "biuf":
            a = arr if arr.dtype.kind == "f" else arr.astype("float64", copy=False)
            nan = int(np.isnan(a).sum()) if a.dtype.kind == "f" else 0
            return {
                "min": _finite(np.nanmin(a)) if nan < a.size else None,
                "max": _finite(np.nanmax(a)) if nan < a.size else None,
                "mean": _finite(np.nanmean(a)) if nan < a.size else None,
                "nan": nan,
            }
        if arr.dtype.kind == "b":
            return {"true": int(arr.sum()), "nan": 0}
    except Exception:
        return None
    return None


def _tensor_stats(t):
    """min/max/mean for torch tensors computed on-device (no host copy)."""
    try:
        if t.numel() == 0 or t.numel() > 50_000_000:
            return None
        if t.dtype.is_floating_point or t.dtype.is_complex:
            f = t.detach().float() if t.dtype != __import__("torch").float64 else t.detach()
            nan = int(__import__("torch").isnan(f).sum().item())
            if nan == f.numel():
                return {"nan": nan}
            return {"min": _finite(f.nan_to_num(nan=float("inf")).min().item()),
                    "max": _finite(f.nan_to_num(nan=float("-inf")).max().item()),
                    "mean": _finite(f.nanmean().item()), "nan": nan}
        if t.dtype == __import__("torch").bool:
            return {"true": int(t.sum().item()), "nan": 0}
        d = t.detach()
        return {"min": _finite(d.min().item()), "max": _finite(d.max().item()), "mean": _finite(d.float().mean().item()), "nan": 0}
    except Exception:
        return None


def _short_repr(obj, n=120):
    try:
        s = repr(obj)
    except Exception as e:  # noqa: BLE001
        s = f"<repr failed: {e!r}>"
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def _kind(obj):
    if _is_numpy(obj):
        return "ndarray"
    if _is_xarray(obj):
        return "xarray"
    if _is_polars_series(obj):
        return "series"
    if _is_pil(obj):
        return "image"
    if _is_nn_module(obj):
        return "model"
    if _is_pandas_df(obj):
        return "dataframe"
    if _is_pandas_series(obj):
        return "series"
    if _is_polars_df(obj):
        return "polars"
    if _is_torch(obj):
        return "tensor"
    if _is_jax(obj):
        return "jax"
    if isinstance(obj, types.ModuleType):
        return "module"
    if inspect.isclass(obj):
        return "class"
    if callable(obj) and not isinstance(obj, type):
        return "function"
    if isinstance(obj, dict):
        return "dict"
    if isinstance(obj, (list, tuple, set, frozenset)):
        return "sequence"
    if isinstance(obj, (str, bytes)):
        return "text"
    if isinstance(obj, (int, float, complex, bool)) or obj is None:
        return "scalar"
    return "object"


def summarize(name, obj):
    kind = _kind(obj)
    info = {
        "name": name,
        "kind": kind,
        "type": type(obj).__name__,
        "module": type(obj).__module__,
        "size": _nbytes(obj),
        "id": id(obj),
    }
    if kind in ("ndarray", "tensor", "jax", "xarray"):
        info["shape"] = list(_safe(lambda: tuple(int(s) for s in obj.shape), ()))
        info["dtype"] = str(_safe(lambda: obj.dtype, ""))
        if kind == "tensor":
            info["device"] = str(_safe(lambda: obj.device, ""))
            info["requires_grad"] = bool(_safe(lambda: obj.requires_grad, False))
            info["dtype"] = info["dtype"].replace("torch.", "")
            info["stats"] = _tensor_stats(obj)
        elif kind == "ndarray":
            info["stats"] = _array_stats(obj)
        elif kind == "xarray":
            info["dims"] = [str(d) for d in _safe(lambda: obj.dims, ())]
            info["stats"] = _safe(lambda: _array_stats(obj.values))
        elif kind == "jax":
            info["device"] = str(_safe(lambda: list(obj.devices())[0], ""))
            info["stats"] = _safe(lambda: _array_stats(__import__("numpy").asarray(obj)))
        dims = f" dims={tuple(info['dims'])}" if kind == "xarray" else ""
        info["value"] = f"{info['type']} {tuple(info['shape'])} {info['dtype']}{dims}"
    elif kind == "model":
        n_params = _safe(lambda: sum(p.numel() for p in obj.parameters()), 0)
        n_train = _safe(lambda: sum(p.numel() for p in obj.parameters() if p.requires_grad), 0)
        dev = _safe(lambda: str(next(obj.parameters()).device), "")
        info["params"] = n_params
        info["device"] = dev
        info["value"] = f"{info['type']} · {n_params:,} params ({n_train:,} trainable){' · ' + dev if dev else ''}"
    elif kind == "image":
        info["shape"] = [int(obj.size[1]), int(obj.size[0])]
        info["dtype"] = str(obj.mode)
        info["value"] = f"Image {obj.size[0]}×{obj.size[1]} {obj.mode}"
    elif kind in ("dataframe", "polars"):
        info["shape"] = list(_safe(lambda: tuple(int(s) for s in obj.shape), ()))
        info["columns"] = [str(c) for c in _safe(lambda: list(obj.columns)[:200], [])]
        info["value"] = f"DataFrame {tuple(info['shape'])}"
    elif kind == "series":
        info["shape"] = [int(len(obj))]
        info["dtype"] = str(obj.dtype)
        info["value"] = f"Series ({len(obj)},) {obj.dtype}"
        info["stats"] = _safe(lambda: _array_stats(obj.to_numpy()))
    elif kind in ("dict", "sequence", "text"):
        info["len"] = _safe(lambda: len(obj))
        info["value"] = _short_repr(obj)
    elif kind == "module":
        info["value"] = getattr(obj, "__file__", "") or ""
    elif kind == "function":
        info["value"] = _safe(lambda: str(inspect.signature(obj)), "(...)")
    elif kind == "class":
        info["value"] = obj.__module__ + "." + obj.__qualname__
    else:
        info["value"] = _short_repr(obj)
    return info


def _namespace():
    ip = sys.modules.get("IPython") and __import__("IPython").get_ipython()
    if ip is not None:
        return ip.user_ns
    return __import__("__main__").__dict__


def snapshot(include_hidden=False):
    """Summaries for every object in the user namespace.  Called via user_expressions."""
    ns = _namespace()
    out = []
    for name, obj in list(ns.items()):
        if name in IPY_NAMES:
            continue
        if not include_hidden and name.startswith(HIDDEN_PREFIXES):
            continue
        try:
            out.append(summarize(name, obj))
        except Exception as e:  # noqa: BLE001
            out.append({"name": name, "kind": "object", "type": type(obj).__name__,
                        "value": f"<error: {e!r}>", "size": 0})
    return _Payload({"variables": out})


def _resolve(path):
    ns = _namespace()
    parts = path.split(".")
    obj = ns[parts[0]]
    for p in parts[1:]:
        if p.startswith("[") and p.endswith("]"):
            key = p[1:-1]
            try:
                key = int(key)
            except ValueError:
                key = key.strip("'\"")
            obj = obj[key]
        else:
            try:
                obj = getattr(obj, p)
            except AttributeError:
                if p.isdigit():
                    obj = obj[int(p)]
                else:
                    raise
    return obj


def _to_cell(v):
    if v is None:
        return None
    import datetime as _dt
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat(sep=" ") if isinstance(v, _dt.datetime) else v.isoformat()
    if isinstance(v, _dt.timedelta):
        return str(v)
    try:
        import pandas as _pd
        if v is _pd.NaT:
            return None
        if isinstance(v, _pd.Timestamp):
            return v.isoformat(sep=" ")
        if isinstance(v, _pd.Timedelta):
            return str(v)
    except Exception:
        pass
    if isinstance(v, (bool, str)):
        return v
    if isinstance(v, (int,)):
        return v if abs(v) < 2**53 else str(v)
    try:
        import numpy as np
        if isinstance(v, np.generic):
            v = v.item()
    except Exception:
        pass
    if isinstance(v, float):
        return None if v != v else _finite(v)
    if isinstance(v, int):
        return v if abs(v) < 2**53 else str(v)
    return _short_repr(v, 60)


def detail(path, row0=0, row1=200, col0=0, col1=50, index=None):
    """A 2-D window of a variable, for the virtualized table viewer.

    ``index`` selects the leading axes of an N-D array (list of ints) so the
    viewer can page through higher dimensions MATLAB-style.
    """
    obj = _resolve(path)
    kind = _kind(obj)
    res = {"path": path, "kind": kind, "type": type(obj).__name__}

    if kind == "image":
        import numpy as np
        arr = np.asarray(obj)
        kind = "ndarray"
        res["kind"] = "ndarray"
        obj = arr

    if kind == "model":
        rows, children = [], []
        for name, p in obj.named_parameters():
            rows.append([name, f"{tuple(p.shape)}", str(p.dtype).replace("torch.", ""), bool(p.requires_grad), str(p.device), int(p.numel())])
            children.append(summarize(name, p))
        for name, b in obj.named_buffers():
            rows.append([name + " (buffer)", f"{tuple(b.shape)}", str(b.dtype).replace("torch.", ""), False, str(b.device), int(b.numel())])
            children.append(summarize(name, b))
        res["nrows"], res["ncols"] = len(rows), 6
        res["columns"] = ["parameter", "shape", "dtype", "grad", "device", "numel"]
        res["rows"] = rows[row0:row1]
        res["children"] = children[row0:row1]
        res["repr"] = _short_repr(obj, 4000)
        return _Payload(res)

    if kind in ("tensor", "jax", "ndarray", "xarray"):
        import numpy as np
        if kind == "tensor":
            arr = obj.detach().cpu().numpy() if obj.numel() < 100_000_000 else None
        elif kind == "jax":
            arr = np.asarray(obj)
        elif kind == "xarray":
            arr = obj.values
            res["dims"] = [str(d) for d in obj.dims]
        else:
            arr = obj
        if arr is None:
            res["error"] = "tensor too large to transfer"
            return _Payload(res)
        arr = np.asarray(arr)
        res["shape"] = list(arr.shape)
        res["dtype"] = str(arr.dtype)
        if arr.ndim == 0:
            res["rows"] = [[_to_cell(arr.item())]]
            res["nrows"], res["ncols"] = 1, 1
        elif arr.ndim == 1:
            res["nrows"], res["ncols"] = int(arr.shape[0]), 1
            res["rows"] = [[_to_cell(x)] for x in arr[row0:row1].tolist()]
        else:
            lead = tuple(index or [0] * (arr.ndim - 2))
            view = arr[lead]
            res["index"] = list(lead)
            res["nrows"], res["ncols"] = int(view.shape[0]), int(view.shape[1])
            res["rows"] = [[_to_cell(x) for x in r] for r in view[row0:row1, col0:col1].tolist()]
        res["row0"], res["col0"] = row0, col0
        return _Payload(res)

    if kind in ("dataframe", "polars", "series"):
        if kind == "series" and _is_polars_series(obj):
            n = len(obj)
            res["nrows"], res["ncols"] = n, 1
            res["columns"] = [str(obj.name)]
            res["dtypes"] = [str(obj.dtype)]
            res["index_labels"] = list(range(row0, min(row1, n)))
            res["rows"] = [[_to_cell(v)] for v in obj.slice(row0, row1 - row0).to_list()]
            res["row0"], res["col0"] = row0, col0
            return _Payload(res)
        if kind == "series":
            df = obj.to_frame()
        elif kind == "polars":
            df = obj.slice(row0, row1 - row0).to_pandas()
            res["nrows"], res["ncols"] = int(obj.shape[0]), int(obj.shape[1])
            res["columns"] = [str(c) for c in obj.columns[col0:col1]]
            res["index_labels"] = list(range(row0, min(row1, obj.shape[0])))
            res["rows"] = [[_to_cell(v) for v in r] for r in df.iloc[:, col0:col1].itertuples(index=False)]
            res["row0"], res["col0"] = row0, col0
            return _Payload(res)
        else:
            df = obj
        res["nrows"], res["ncols"] = int(df.shape[0]), int(df.shape[1])
        res["columns"] = [str(c) for c in df.columns[col0:col1]]
        res["dtypes"] = [str(t) for t in df.dtypes.iloc[col0:col1]]
        win = df.iloc[row0:row1, col0:col1]
        res["index_labels"] = [_to_cell(i) for i in win.index.tolist()]
        res["rows"] = [[_to_cell(v) for v in r] for r in win.itertuples(index=False)]
        res["row0"], res["col0"] = row0, col0
        return _Payload(res)

    if kind == "dict":
        items = list(obj.items())
        res["nrows"], res["ncols"] = len(items), 2
        res["columns"] = ["key", "value"]
        res["rows"] = [[_to_cell(k), _to_cell(v)] for k, v in items[row0:row1]]
        res["children"] = [summarize(f"[{k!r}]" if not isinstance(k, str) else f"[{k!r}]", v)
                           for k, v in items[row0:row1]]
        return _Payload(res)

    if kind == "sequence":
        items = list(obj)
        res["nrows"], res["ncols"] = len(items), 1
        res["columns"] = ["value"]
        res["rows"] = [[_to_cell(v)] for v in items[row0:row1]]
        res["children"] = [summarize(f"[{i}]", v) for i, v in enumerate(items[row0:row1], start=row0)]
        return _Payload(res)

    # generic object: show attributes
    attrs = []
    for a in dir(obj):
        if a.startswith("_"):
            continue
        v = _safe(lambda: getattr(obj, a))
        if callable(v):
            continue
        attrs.append((a, v))
    res["nrows"], res["ncols"] = len(attrs), 2
    res["columns"] = ["attribute", "value"]
    res["rows"] = [[a, _to_cell(v)] for a, v in attrs[row0:row1]]
    res["children"] = [summarize(a, v) for a, v in attrs[row0:row1]]
    res["repr"] = _short_repr(obj, 2000)
    return _Payload(res)


def plot_data(path, max_points=20000):
    """Numeric payload for quick plots from the workspace panel."""
    import numpy as np
    obj = _resolve(path)
    kind = _kind(obj)
    if kind == "tensor":
        arr = obj.detach().cpu().numpy()
    elif kind in ("dataframe", "series"):
        arr = obj.to_numpy()
        cols = [str(c) for c in obj.columns] if kind == "dataframe" else [str(obj.name)]
    elif kind == "polars":
        arr = obj.to_numpy()
    else:
        arr = np.asarray(obj)
    cols = locals().get("cols")
    arr = np.asarray(arr)
    res = {"path": path, "shape": list(arr.shape), "dtype": str(arr.dtype)}
    if arr.ndim == 1:
        step = max(1, arr.shape[0] // max_points)
        res["y"] = [_finite(v) for v in arr[::step].astype("float64").tolist()]
        res["step"] = step
    elif arr.ndim == 2:
        if arr.shape[0] * arr.shape[1] > 4_000_000:
            s0 = max(1, arr.shape[0] // 2000)
            s1 = max(1, arr.shape[1] // 2000)
            arr = arr[::s0, ::s1]
        res["z"] = [[_finite(v) for v in r] for r in arr.astype("float64").tolist()]
        if cols:
            res["columns"] = cols
    else:
        res["error"] = f"{arr.ndim}-D arrays: select a 2-D slice first"
    return _Payload(res)


# ----------------------------------------------------------------------------
# images and expression plots (stage 3)
# ----------------------------------------------------------------------------

def _as_numpy(obj):
    import numpy as np
    kind = _kind(obj)
    if kind == "tensor":
        return obj.detach().cpu().numpy()
    if kind in ("dataframe", "series", "polars"):
        return obj.to_numpy()
    if kind == "xarray":
        return obj.values
    return np.asarray(obj)


def _guess_layout(shape):
    """Return (layout, extra_dims) for an array shape: 'HW', 'HWC' or 'CHW'."""
    n = len(shape)
    if n < 2:
        return None, 0
    if n == 2:
        return "HW", 0
    # last axis is 1/3/4 -> HWC ; third-from-last is 1/3/4 -> CHW
    if shape[-1] in (1, 3, 4):
        return "HWC", n - 3
    if shape[-3] in (1, 3, 4):
        return "CHW", n - 3
    return "HW", n - 2


def image(path, index=None, vmin=None, vmax=None, layout="auto", max_px=4_000_000):
    """Normalized uint8 pixels for the image viewer.

    Returns base64 bytes in HxW (gray) or HxWx3 (rgb) order plus the value
    range used, so the frontend can apply a colormap and show pixel values.
    """
    import base64
    import numpy as np

    arr = _as_numpy(_resolve(path))
    shape = list(arr.shape)
    if arr.ndim < 2:
        return _Payload({"path": path, "error": "need at least 2 dimensions"})
    lay, extra = _guess_layout(shape) if layout == "auto" else (layout, len(shape) - (2 if layout == "HW" else 3))
    idx = tuple(index or [0] * extra)
    view = arr[idx] if extra else arr
    if lay == "CHW":
        view = np.moveaxis(view, 0, -1)
    if lay in ("HWC", "CHW"):
        if view.shape[-1] == 1:
            view = view[..., 0]
            lay = "HW"
        elif view.shape[-1] == 4:
            view = view[..., :3]
    # downsample very large images
    h, w = view.shape[0], view.shape[1]
    step = int(np.ceil(np.sqrt(h * w / max_px))) if h * w > max_px else 1
    if step > 1:
        view = view[::step, ::step]
    view = np.asarray(view)
    if view.dtype == bool:
        view = view.astype(np.uint8)
    if view.dtype.kind not in "biuf":
        return _Payload({"path": path, "error": f"dtype {view.dtype} is not numeric"})
    f = view.astype(np.float64)
    finite = np.isfinite(f)
    lo = float(np.nanmin(f[finite])) if vmin is None and finite.any() else (vmin if vmin is not None else 0.0)
    hi = float(np.nanmax(f[finite])) if vmax is None and finite.any() else (vmax if vmax is not None else 1.0)
    # uint8 images: keep the natural 0..255 range
    if vmin is None and vmax is None and view.dtype == np.uint8:
        lo, hi = 0.0, 255.0
    if hi <= lo:
        hi = lo + 1.0
    norm = np.clip((f - lo) / (hi - lo), 0, 1)
    norm[~finite] = 0
    u8 = (norm * 255).astype(np.uint8)
    out = {
        "path": path,
        "shape": shape,
        "dtype": str(arr.dtype),
        "layout": lay,
        "extra": [int(s) for s in shape[:extra]],
        "index": list(idx),
        "h": int(u8.shape[0]),
        "w": int(u8.shape[1]),
        "channels": 3 if u8.ndim == 3 else 1,
        "vmin": lo,
        "vmax": hi,
        "step": step,
        "data": base64.b64encode(np.ascontiguousarray(u8).tobytes()).decode("ascii"),
    }
    return _Payload(out)


def _ns_eval(expr):
    return eval(expr, {"np": __import__("numpy")}, _namespace())  # noqa: S307 (user's own kernel)


def plot_expr(expr, max_points=20000):
    """Like plot_data, but for an arbitrary expression such as df[['a','b']] or x[:, 2]."""
    import numpy as np
    obj = _ns_eval(expr)
    kind = _kind(obj)
    cols = None
    if kind == "dataframe":
        cols = [str(c) for c in obj.columns]
    elif kind == "series":
        cols = [str(obj.name)]
    elif kind == "polars":
        cols = [str(c) for c in obj.columns]
    arr = _as_numpy(obj)
    res = {"path": expr, "shape": list(arr.shape), "dtype": str(arr.dtype)}
    if arr.dtype.kind not in "biuf":
        try:
            arr = arr.astype("float64")
        except Exception:
            res["error"] = f"cannot plot dtype {arr.dtype}"
            return _Payload(res)
    if arr.ndim == 0:
        arr = arr.reshape(1)
    if arr.ndim == 1:
        step = max(1, arr.shape[0] // max_points)
        res["y"] = [_finite(v) for v in arr[::step].astype("float64").tolist()]
        res["step"] = step
    elif arr.ndim == 2:
        if arr.shape[0] * arr.shape[1] > 4_000_000:
            s0 = max(1, arr.shape[0] // 2000)
            s1 = max(1, arr.shape[1] // 2000)
            arr = arr[::s0, ::s1]
        res["z"] = [[_finite(v) for v in r] for r in arr.astype("float64").tolist()]
        if cols:
            res["columns"] = cols
    else:
        res["error"] = f"{arr.ndim}-D: select a 2-D slice first"
    return _Payload(res)


def run_file(path, argv=None):
    """Execute a script in the user namespace with its real filename, so
    tracebacks and debugger breakpoints refer to the file (like MATLAB's Run)."""
    import sys
    ns = _namespace()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = compile(src, path, "exec")
    old_argv, old_file = sys.argv, ns.get("__file__")
    sys.argv = [path] + list(argv or [])
    ns["__file__"] = path
    try:
        exec(code, ns)
    finally:
        sys.argv = old_argv
        if old_file is None:
            ns.pop("__file__", None)
        else:
            ns["__file__"] = old_file


# ----------------------------------------------------------------------------
# file system access (used when the kernel runs on another machine)
# ----------------------------------------------------------------------------

def fs_list(path):
    import os
    path = os.path.expanduser(path or "~")
    out = []
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    st = e.stat(follow_symlinks=True)
                    is_dir = e.is_dir(follow_symlinks=True)
                except OSError:
                    continue
                out.append({"name": e.name, "path": os.path.join(path, e.name), "is_dir": is_dir,
                            "size": int(st.st_size), "modified": int(st.st_mtime)})
    except OSError as e:
        return _Payload({"path": path, "error": str(e)})
    out.sort(key=lambda d: (not d["is_dir"], d["name"].lower()))
    return _Payload({"path": os.path.abspath(path), "entries": out})


def fs_read(path):
    import os
    try:
        with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as f:
            return _Payload({"path": path, "text": f.read()})
    except OSError as e:
        return _Payload({"path": path, "error": str(e)})


def fs_write(path, b64):
    import base64
    import os
    try:
        p = os.path.expanduser(path)
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "wb") as f:
            f.write(base64.b64decode(b64))
        return _Payload({"path": path, "ok": True})
    except OSError as e:
        return _Payload({"path": path, "error": str(e)})


def fs_info():
    import os
    import socket
    return _Payload({"cwd": os.getcwd(), "home": os.path.expanduser("~"), "host": socket.gethostname(), "sep": os.sep})
