"""pide_kernel: runs inside an ipykernel and exposes the user namespace to the IDE.

Everything here is invoked through Jupyter ``user_expressions`` so that it rides
on the normal execute_request/execute_reply round trip.  Results are returned as
objects with ``_repr_mimebundle_`` so IPython forwards a JSON object (not a
string) under our own mime type.

Performance notes: ``snapshot()`` runs after every cell for every variable, so
nothing in the summary path may import a library speculatively, copy a large
array, or build a full ``repr`` of a big container.  Heavy work is cached and
subject to a per-snapshot time budget.
"""
from __future__ import annotations

import collections
import inspect
import itertools
import json
import math
import os
import reprlib
import sys
import time
import types

MIME = "application/x-pide+json"

HIDDEN_PREFIXES = ("_",)
IPY_NAMES = {"In", "Out", "get_ipython", "exit", "quit", "open"}

# stats: arrays above this many elements are sampled with a stride so that the
# sample has at most _STATS_SAMPLE elements (and the result is flagged approx)
_STATS_MAX = 10_000_000
_STATS_SAMPLE = 1_000_000
_STATS_CACHE_MAX = 256
_STATS_BUDGET_S = 0.2  # per snapshot() call
_DEVICE_STATS_MAX = 1_000_000  # non-CPU tensors / jax arrays above this get no stats
_CELL_STR_MAX = 1000
_FS_READ_MAX = 50 * 1024 * 1024


def _json_default(o):
    item = getattr(o, "item", None)  # numpy scalars and 0-d arrays
    if callable(item):
        try:
            v = item()
            if isinstance(v, (bool, int, str)) or (isinstance(v, float) and math.isfinite(v)):
                return v
        except Exception:  # noqa: BLE001
            pass
    return str(o)


class _Payload:
    def __init__(self, data):
        self.data = data

    def _repr_mimebundle_(self, include=None, exclude=None):
        used = []

        def default(o):
            used.append(1)
            return _json_default(o)

        try:
            s = json.dumps(self.data, allow_nan=False, default=default)
        except (TypeError, ValueError, OverflowError, RecursionError) as e:
            return {MIME: {"error": f"payload is not JSON serializable: {e!r}"}}
        if used:  # something non-JSON slipped through: hand over the cleaned copy
            return {MIME: json.loads(s)}
        return {MIME: self.data}


# ----------------------------------------------------------------------------
# type detection (never imports anything: a value cannot be an instance of a
# library's class unless that library is already in sys.modules)
# ----------------------------------------------------------------------------

_CLS_CACHE: dict = {}


def _classes(modname, names):
    """Resolve dotted class names from an *already imported* module.

    Returns a tuple of classes (possibly empty).  Cached per module object so the
    cost per call is two dict lookups.
    """
    m = sys.modules.get(modname)
    if m is None:
        return ()
    ck = (modname, names)
    ent = _CLS_CACHE.get(ck)
    if ent is not None and ent[0] is m:
        return ent[1]
    out = []
    complete = True
    for n in names:
        c = m
        for part in n.split("."):
            c = getattr(c, part, None)
            if c is None:
                break
        if isinstance(c, type):
            out.append(c)
        else:
            complete = False
    out = tuple(out)
    if complete:  # a half-imported module is not cached
        _CLS_CACHE[ck] = (m, out)
    return out


def _mod(obj):
    return type(obj).__module__.split(".")[0]


def _isinst(obj, modname, names, fallback=()):
    cls = _classes(modname, names)
    if cls:
        try:
            if isinstance(obj, cls):
                return True
        except Exception:  # noqa: BLE001
            return False
    return bool(fallback) and _mod(obj) == modname.split(".")[0] and type(obj).__name__ in fallback


def _is_numpy(obj):
    cls = _classes("numpy", ("ndarray",))
    if cls:
        return isinstance(obj, cls)
    return _mod(obj) == "numpy" and hasattr(obj, "shape") and hasattr(obj, "dtype")


def _is_numpy_scalar(obj):
    cls = _classes("numpy", ("generic",))
    return bool(cls) and isinstance(obj, cls)


def _is_pandas_df(obj):
    return _isinst(obj, "pandas", ("DataFrame",), ("DataFrame",))


def _is_pandas_series(obj):
    return _isinst(obj, "pandas", ("Series",), ("Series",))


def _is_polars_df(obj):
    return _isinst(obj, "polars", ("DataFrame",), ("DataFrame",))


def _is_polars_series(obj):
    return _isinst(obj, "polars", ("Series",), ("Series",))


def _is_polars_lazy(obj):
    return _isinst(obj, "polars", ("LazyFrame",), ("LazyFrame",))


def _is_torch(obj):
    return _isinst(obj, "torch", ("Tensor",), ("Tensor", "Parameter"))


def _is_nn_module(obj):
    cls = _classes("torch", ("nn.Module",))
    if not cls:
        return False  # torch not imported -> cannot be a Module
    try:
        return isinstance(obj, cls)
    except Exception:  # noqa: BLE001
        return False


def _is_xarray(obj):
    return _isinst(obj, "xarray", ("DataArray", "Variable"), ("DataArray", "Variable", "IndexVariable"))


def _is_xarray_dataset(obj):
    return _isinst(obj, "xarray", ("Dataset",), ("Dataset",))


def _is_pil(obj):
    cls = _classes("PIL.Image", ("Image",))
    if cls:
        return isinstance(obj, cls)
    return _mod(obj) == "PIL" and hasattr(obj, "size") and hasattr(obj, "mode")


def _is_jax(obj):
    cls = _classes("jax", ("Array",))
    if cls:
        try:
            return isinstance(obj, cls)
        except Exception:  # noqa: BLE001
            return False
    return _mod(obj) in ("jaxlib", "jax") and hasattr(obj, "shape") and hasattr(obj, "dtype")


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def _finite(x):
    try:
        f = float(x)
    except Exception:  # noqa: BLE001
        return None
    if math.isnan(f) or math.isinf(f):
        return str(f)
    return f


def _nbytes(obj):
    if _is_numpy(obj):
        return int(obj.nbytes)
    if _is_pandas_df(obj):
        return int(_safe(lambda: obj.memory_usage(deep=False).sum(), 0))
    if _is_pandas_series(obj):
        return int(_safe(lambda: obj.memory_usage(deep=False), 0))
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


# ----------------------------------------------------------------------------
# bounded reprs
# ----------------------------------------------------------------------------

class _Repr(reprlib.Repr):
    """reprlib.Repr that never sorts or walks whole dicts/sets and that routes
    large builtin-container subclasses through the bounded code paths."""

    _BASES = (dict, list, tuple, set, frozenset)

    def __init__(self):
        super().__init__()
        self.maxlevel = 3
        self.maxlist = self.maxtuple = self.maxset = self.maxfrozenset = self.maxdict = 8
        self.maxdeque = self.maxarray = 8
        self.maxstring = 80
        self.maxlong = 40
        self.maxother = 80

    def _items(self, x, level, n, open_, close):
        if len(x) == 0:
            return open_ + close
        if level <= 0:
            return open_ + "..." + close
        pieces = [self.repr1(e, level - 1) for e in itertools.islice(x, n)]
        if len(x) > n:
            pieces.append("...")
        return open_ + ", ".join(pieces) + close

    def repr_dict(self, x, level):
        if len(x) == 0:
            return "{}"
        if level <= 0:
            return "{...}"
        pieces = []
        for k in itertools.islice(x, self.maxdict):
            pieces.append(f"{self.repr1(k, level - 1)}: {self.repr1(x[k], level - 1)}")
        if len(x) > self.maxdict:
            pieces.append("...")
        return "{" + ", ".join(pieces) + "}"

    def repr_set(self, x, level):
        return self._items(x, level, self.maxset, "{", "}")

    def repr_frozenset(self, x, level):
        return self._items(x, level, self.maxfrozenset, "frozenset({", "})")

    def repr1(self, x, level):
        t = type(x)
        if t not in self._BASES and isinstance(x, self._BASES) and _safe(lambda: len(x), 0) > 200:
            # a big subclass (OrderedDict, defaultdict, ...): never call its own __repr__
            for base, meth in ((dict, self.repr_dict), (list, self.repr_list), (tuple, self.repr_tuple),
                               (set, self.repr_set), (frozenset, self.repr_frozenset)):
                if isinstance(x, base):
                    return meth(x, level)
        return super().repr1(x, level)


_REPR = _Repr()
_CONTAINERS = (list, tuple, set, frozenset, dict, collections.deque)


def _short_repr(obj, n=120):
    """A repr of at most ``n`` characters that never materializes a huge string."""
    try:
        if isinstance(obj, (str, bytes)):
            s = repr(obj[:n])
            if len(obj) > n:
                s += "…"
        elif isinstance(obj, _CONTAINERS):
            ln = len(obj)
            if ln > 10_000:
                s = f"<{type(obj).__name__} of {ln} items> " + _REPR.repr(obj)
            else:
                s = _REPR.repr(obj)
        else:
            s = repr(obj)
    except Exception as e:  # noqa: BLE001
        s = f"<repr failed: {e!r}>"
    if len(s) > n:
        s = s[: n - 1] + "…"
    return s.replace("\n", " ")


def _full_repr(obj, n):
    """repr for detail(): full for ordinary objects, bounded for big containers."""
    if isinstance(obj, _CONTAINERS):
        return _short_repr(obj, n)
    try:
        s = repr(obj)
    except Exception as e:  # noqa: BLE001
        s = f"<repr failed: {e!r}>"
    return s if len(s) <= n else s[: n - 1] + "…"


# ----------------------------------------------------------------------------
# stats (cached, budgeted, never copying)
# ----------------------------------------------------------------------------

_STATS_CACHE: "collections.OrderedDict" = collections.OrderedDict()
_DEADLINE = [None]


def _budget_ok():
    d = _DEADLINE[0]
    return d is None or time.monotonic() < d


def _cache_get(key):
    v = _STATS_CACHE.get(key)
    if v is not None:
        _STATS_CACHE.move_to_end(key)
    return v


def _cache_put(key, val):
    _STATS_CACHE[key] = val
    _STATS_CACHE.move_to_end(key)
    while len(_STATS_CACHE) > _STATS_CACHE_MAX:
        _STATS_CACHE.popitem(last=False)


def _memmap_backed(np, arr):
    mm = getattr(np, "memmap", None)
    if mm is None:
        return False
    b = arr
    for _ in range(8):
        if b is None:
            return False
        if isinstance(b, mm):
            return True
        b = getattr(b, "base", None)
    return False


def _fingerprint(arr, size):
    """Bytes of ~32 strided elements: catches in-place edits that keep id/ptr/shape."""
    try:
        if not (arr.flags.c_contiguous or arr.flags.f_contiguous):
            return None
        flat = arr.ravel(order="K")
        return flat[:: max(1, size // 32)].tobytes()
    except Exception:  # noqa: BLE001
        return None


def _np_stats(np, a, kind, n_total=None, k=1):
    with np.errstate(all="ignore"):  # inf/-inf reductions must not print warnings in the kernel
        return _np_stats_inner(np, a, kind, k)


def _np_stats_inner(np, a, kind, k):
    if kind == "b":
        true = int(np.count_nonzero(a))
        n = int(a.size)
        return {"min": 0 if true < n else 1, "max": 1 if true else 0, "mean": true / n, "true": true * k, "nan": 0}
    if kind in "iu":
        return {"min": int(a.min()), "max": int(a.max()), "mean": _finite(a.mean(dtype="float64")), "nan": 0}
    nan = int(np.count_nonzero(np.isnan(a)))
    if nan >= a.size:
        return {"min": None, "max": None, "mean": None, "nan": nan * k}
    if nan:
        mn, mx, mean = np.nanmin(a), np.nanmax(a), np.nanmean(a)
    else:
        mn, mx, mean = a.min(), a.max(), a.mean()
    return {"min": _finite(mn), "max": _finite(mx), "mean": _finite(mean), "nan": nan * k}


def _array_stats(arr, owner=None):
    """min/max/mean/nan count for a numeric numpy array.

    No copies: integer reductions use native dtypes, NaN counting uses
    count_nonzero(isnan).  memmap-backed arrays are skipped.  Arrays above
    _STATS_MAX elements are sampled with a stride (``approx: True``).  Results
    are cached by (id, data pointer, shape, dtype, fingerprint), 256 entries.
    """
    np = sys.modules.get("numpy")
    if np is None:
        return None
    try:
        size = int(arr.size)
        if size == 0 or arr.dtype.kind not in "biuf":
            return None
        if _memmap_backed(np, arr):
            return None
        try:
            ptr = arr.__array_interface__["data"][0]
        except Exception:  # noqa: BLE001
            ptr = None
        key = ("np", id(owner if owner is not None else arr), ptr, tuple(arr.shape), arr.dtype.str,
               _fingerprint(arr, size))
        hit = _cache_get(key)
        if hit is not None:
            return hit
        if not _budget_ok():
            return None
        a, k = arr, 1
        if size > _STATS_MAX:
            if not (arr.flags.c_contiguous or arr.flags.f_contiguous):
                return None
            k = -(-size // _STATS_SAMPLE)  # ceil
            a = arr.ravel(order="K")[::k]
        res = _np_stats(np, a, arr.dtype.kind, size, k)
        if k > 1:
            res["approx"] = True
        _cache_put(key, res)
        return res
    except Exception:  # noqa: BLE001
        return None


def _torch_reduce(torch, d):
    """Reductions on-device, collected with a single host sync."""
    acc = torch.float32 if d.device.type == "mps" else torch.float64
    n = d.numel()
    if d.dtype == torch.bool:
        true = int(d.sum().item())
        return {"min": 0 if true < n else 1, "max": 1 if true else 0, "mean": true / n, "true": true, "nan": 0}
    if d.dtype.is_floating_point:
        try:
            mn, mx = torch.aminmax(d)
            mean = torch.nanmean(d)
            nan = torch.isnan(d).sum()
        except (RuntimeError, NotImplementedError, TypeError):  # op unsupported for this dtype
            d = d.float()
            mn, mx = torch.aminmax(d)
            mean = torch.nanmean(d)
            nan = torch.isnan(d).sum()
        mn, mx, mean, nan = torch.stack([mn.to(acc), mx.to(acc), mean.to(acc), nan.to(acc)]).tolist()
        nan = int(nan)
        if nan >= n:
            return {"min": None, "max": None, "mean": None, "nan": nan}
        if nan:  # aminmax propagated NaN: one more pass without the NaNs
            mn, mx = torch.stack([torch.nan_to_num(d, nan=math.inf).min().to(acc),
                                  torch.nan_to_num(d, nan=-math.inf).max().to(acc)]).tolist()
        return {"min": _finite(mn), "max": _finite(mx), "mean": _finite(mean), "nan": nan}
    mn, mx = torch.aminmax(d)
    s = d.sum(dtype=acc)
    mn, mx, s = torch.stack([mn.to(acc), mx.to(acc), s]).tolist()
    return {"min": int(mn), "max": int(mx), "mean": _finite(s / n), "nan": 0}


def _tensor_stats(t):
    """min/max/mean for torch tensors computed on-device (one sync, no host copy)."""
    torch = sys.modules.get("torch")
    if torch is None:
        return None
    try:
        n = int(t.numel())
        if n == 0 or t.dtype.is_complex or t.layout != torch.strided or t.device.type == "meta":
            return None
        dev = t.device.type
        if dev != "cpu" and n > _DEVICE_STATS_MAX:
            return None
        key = ("torch", id(t), t.data_ptr(), t._version, tuple(t.shape), str(t.dtype))
        hit = _cache_get(key)
        if hit is not None:
            return hit
        if not _budget_ok():
            return None
        d, k = t.detach(), 1
        if n > _STATS_MAX:
            if not d.is_contiguous():
                return None
            k = -(-n // _STATS_SAMPLE)
            d = d.view(-1)[::k]
        res = _torch_reduce(torch, d)
        if k > 1:
            res["approx"] = True
            if res.get("nan"):
                res["nan"] = int(res["nan"]) * k
        _cache_put(key, res)
        return res
    except Exception:  # noqa: BLE001
        return None


def _xarray_backing(obj):
    """The numpy array behind an in-memory DataArray/Variable, else None (never loads)."""
    np = sys.modules.get("numpy")
    if np is None:
        return None
    try:
        if getattr(obj, "chunks", None) is not None:
            return None
        var = getattr(obj, "variable", obj)
        data = getattr(var, "_data", None)
        if isinstance(data, np.ndarray):
            return data
    except Exception:  # noqa: BLE001
        pass
    return None


def _jax_stats(obj):
    jax = sys.modules.get("jax")
    jnp = sys.modules.get("jax.numpy")
    if jax is None or jnp is None:
        return None
    try:
        n = int(obj.size)
        kind = getattr(obj.dtype, "kind", "")
        if n == 0 or kind not in "biuf":
            return None
        platform = _safe(lambda: list(obj.devices())[0].platform, "cpu")
        if platform != "cpu" and n > _DEVICE_STATS_MAX:
            return None
        if n > _STATS_MAX:
            return None
        key = ("jax", id(obj), _safe(lambda: obj.unsafe_buffer_pointer()), tuple(obj.shape), str(obj.dtype))
        hit = _cache_get(key)
        if hit is not None:
            return hit
        if not _budget_ok():
            return None
        if kind == "f":
            parts = [jnp.nanmin(obj), jnp.nanmax(obj), jnp.nanmean(obj), jnp.isnan(obj).sum()]
        elif kind == "b":
            parts = [obj.min(), obj.max(), obj.mean(), obj.sum()]
        else:
            parts = [obj.min(), obj.max(), obj.mean()]
        vals = [v.item() for v in jax.device_get(parts)]  # one transfer
        if kind == "f":
            nan = int(vals[3])
            if nan >= n:
                res = {"min": None, "max": None, "mean": None, "nan": nan}
            else:
                res = {"min": _finite(vals[0]), "max": _finite(vals[1]), "mean": _finite(vals[2]), "nan": nan}
        elif kind == "b":
            res = {"min": int(vals[0]), "max": int(vals[1]), "mean": _finite(vals[2]), "true": int(vals[3]), "nan": 0}
        else:
            res = {"min": int(vals[0]), "max": int(vals[1]), "mean": _finite(vals[2]), "nan": 0}
        _cache_put(key, res)
        return res
    except Exception:  # noqa: BLE001
        return None


def _pandas_series_stats(s):
    np = sys.modules.get("numpy")
    if np is None:
        return None
    try:
        dt = s.dtype
        if isinstance(dt, np.dtype):
            if dt.kind not in "biuf":
                return None
            return _array_stats(s.to_numpy(), owner=s)
        if getattr(dt, "kind", "O") in "biuf":  # nullable / arrow-backed numeric
            if not _budget_ok():
                return None
            a = s.to_numpy(dtype="float64", na_value=np.nan)
            return _np_stats(np, a, "f") if a.size else None
    except Exception:  # noqa: BLE001
        pass
    return None


def _polars_series_stats(s):
    try:
        dt = s.dtype
        if not (dt.is_numeric() and len(s)):
            return None
        if not _budget_ok():
            return None
        return {"min": _finite(s.min()), "max": _finite(s.max()), "mean": _finite(s.mean()),
                "nan": int(s.null_count())}
    except Exception:  # noqa: BLE001
        return None


# ----------------------------------------------------------------------------
# summaries
# ----------------------------------------------------------------------------

def _kind(obj):
    if _is_numpy(obj):
        return "ndarray"
    if _is_numpy_scalar(obj):
        return "scalar"
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
            backing = _xarray_backing(obj)
            info["stats"] = _array_stats(backing, owner=obj) if backing is not None else None
        elif kind == "jax":
            info["device"] = str(_safe(lambda: list(obj.devices())[0], ""))
            info["stats"] = _jax_stats(obj)
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
        info["stats"] = _polars_series_stats(obj) if _is_polars_series(obj) else _pandas_series_stats(obj)
    elif kind in ("dict", "sequence", "text"):
        info["len"] = _safe(lambda: len(obj))
        info["value"] = _short_repr(obj)
    elif kind == "module":
        info["value"] = str(getattr(obj, "__file__", "") or "")
    elif kind == "function":
        info["value"] = _safe(lambda: str(inspect.signature(obj)), "(...)")
    elif kind == "class":
        info["value"] = f"{getattr(obj, '__module__', '')}.{getattr(obj, '__qualname__', info['type'])}"
    elif kind == "scalar":
        if _is_numpy_scalar(obj):
            info["dtype"] = str(obj.dtype)
            plain = str(obj) if obj.dtype.kind in "MmSUOV" else _safe(lambda: obj.item(), obj)
            info["value"] = plain if isinstance(plain, str) else _short_repr(plain)
        else:
            info["value"] = _short_repr(obj)
    else:
        qn = type(obj).__qualname__
        if type(obj).__repr__ is object.__repr__:
            info["value"] = f"<{qn}>"
        else:
            info["value"] = f"{qn} · {_short_repr(obj, 80)}"
    return info


def _namespace():
    ip = sys.modules.get("IPython") and __import__("IPython").get_ipython()
    if ip is not None:
        return ip.user_ns
    return __import__("__main__").__dict__


def snapshot(include_hidden=False):
    """Summaries for every object in the user namespace.  Called via user_expressions."""
    out = []
    _DEADLINE[0] = time.monotonic() + _STATS_BUDGET_S
    try:
        ns = _namespace()
        for name, obj in list(ns.items()):
            if not isinstance(name, str):
                continue
            if name in IPY_NAMES:
                continue
            if not include_hidden and name.startswith(HIDDEN_PREFIXES):
                continue
            try:
                out.append(summarize(name, obj))
            except Exception as e:  # noqa: BLE001
                out.append({"name": name, "kind": "object", "type": type(obj).__name__,
                            "value": f"<error: {e!r}>", "size": 0})
    except Exception as e:  # noqa: BLE001
        return _Payload({"variables": [], "error": repr(e)})
    finally:
        _DEADLINE[0] = None
    return _Payload({"variables": out})


# ----------------------------------------------------------------------------
# paths: root(.attr | [json-key] | [#n])*  (``.0`` after a dot also indexes)
# ----------------------------------------------------------------------------

def _parse_path(path):
    n = len(path)
    i = 0
    while i < n and path[i] not in ".[":
        i += 1
    root = path[:i]
    if not root:
        raise ValueError("empty root name")
    segs = []
    dec = json.JSONDecoder()
    while i < n:
        c = path[i]
        if c == ".":
            j = i + 1
            while j < n and path[j] not in ".[":
                j += 1
            name = path[i + 1:j]
            if not name:
                raise ValueError(f"empty attribute name at {i}")
            segs.append(("attr", name))
            i = j
        elif c == "[":
            j = i + 1
            if j < n and path[j] == "#":
                k = path.index("]", j)
                segs.append(("keyidx", int(path[j + 1:k])))
                i = k + 1
            elif j < n and path[j] == '"':
                key, k = dec.raw_decode(path, j)
                if k >= n or path[k] != "]":
                    raise ValueError(f"expected ']' at {k}")
                segs.append(("key", key))
                i = k + 1
            else:
                k = path.index("]", j)
                raw = path[j:k]
                try:
                    key = json.loads(raw)
                except ValueError:
                    key = raw.strip("'\"")  # legacy ['key'] / [key] forms
                segs.append(("key", key))
                i = k + 1
        else:
            raise ValueError(f"unexpected {c!r} at {i}")
    return root, segs


def _step_attr(obj, name):
    try:
        return getattr(obj, name)
    except AttributeError:
        if name.isdigit():  # legacy ``path.0.weight`` (nn.Sequential, lists)
            try:
                return obj[int(name)]
            except (TypeError, IndexError, KeyError):
                pass
        try:
            return obj[name]  # ModuleDict / dict with str keys
        except (TypeError, IndexError, KeyError):
            pass
        raise


def _step_key(obj, key):
    try:
        return obj[key]
    except (KeyError, IndexError, TypeError):
        if isinstance(key, str):
            return getattr(obj, key)
        raise


def _resolve(path):
    ns = _namespace()
    try:
        root, segs = _parse_path(path)
    except (ValueError, IndexError) as e:
        raise ValueError(f"bad path {path!r}: {e}") from None
    if root not in ns:
        raise ValueError(f"{root!r} is not defined")
    obj = ns[root]
    for kind, key in segs:
        try:
            if kind == "attr":
                obj = _step_attr(obj, key)
            elif kind == "key":
                obj = _step_key(obj, key)
            else:
                k = next(itertools.islice(iter(obj), key, None))
                obj = obj[k]
        except (AttributeError, KeyError, TypeError, IndexError, StopIteration) as e:
            raise ValueError(f"cannot resolve {path!r} at {key!r}: {e!r}") from None
    return obj


def _key_name(k, idx):
    """Child name for a dict key: ``[<json>]`` when round-trippable, else ``[#idx]``."""
    if k is None or isinstance(k, (bool, str, int)) or (isinstance(k, float) and math.isfinite(k)):
        try:
            return "[" + json.dumps(k) + "]"
        except (TypeError, ValueError):
            pass
    return f"[#{idx}]"


# ----------------------------------------------------------------------------
# detail windows
# ----------------------------------------------------------------------------

def _to_cell(v):
    if v is None:
        return None
    npg = _classes("numpy", ("generic",))
    if npg and isinstance(v, npg):
        kind = v.dtype.kind
        if kind in "Mm":
            return str(v)
        v = v.item()
        if v is None:
            return None
    import datetime as _dt
    pd = sys.modules.get("pandas")
    if pd is not None:
        if v is pd.NaT or v is pd.NA:
            return None
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat(sep=" ") if isinstance(v, _dt.datetime) else v.isoformat()
    if isinstance(v, _dt.timedelta):
        return str(v)
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v if len(v) <= _CELL_STR_MAX else v[:_CELL_STR_MAX] + "…"
    if isinstance(v, int):
        return v if abs(v) < 2**53 else str(v)
    if isinstance(v, float):
        return None if v != v else _finite(v)
    return _short_repr(v, 60)


def _window_np(obj, kind, idx):
    """numpy array for ``obj[idx]`` without transferring more than the window."""
    import numpy as np
    if kind == "tensor":
        torch = sys.modules["torch"]
        t = obj.detach()
        if t.layout != torch.strided:
            t = t.to_dense()
        t = t[idx]
        if t.dtype == torch.bfloat16:
            t = t.float()
        return t.cpu().numpy()
    if kind == "xarray":
        return np.asarray(obj[idx].values)
    return np.asarray(obj[idx])


def _cells_1d(win):
    import numpy as np
    k = win.dtype.kind
    if k == "M":
        return [[s] for s in np.datetime_as_string(win).tolist()]
    if k == "m":
        return [[s] for s in win.astype(str).tolist()]
    return [[_to_cell(x)] for x in win.tolist()]


def _cells_2d(win):
    import numpy as np
    k = win.dtype.kind
    if k == "M":
        return np.datetime_as_string(win).tolist()
    if k == "m":
        return win.astype(str).tolist()
    return [[_to_cell(x) for x in r] for r in win.tolist()]


def _property_stub(name):
    return {"name": name, "kind": "object", "type": "property", "value": "<property>", "size": 0}


def detail(path, row0=0, row1=200, col0=0, col1=50, index=None):
    """A 2-D window of a variable, for the virtualized table viewer.

    ``index`` selects the leading axes of an N-D array (list of ints) so the
    viewer can page through higher dimensions MATLAB-style.
    """
    obj = _resolve(path)
    kind = _kind(obj)
    res = {"path": path, "kind": kind, "type": type(obj).__name__}
    row0, row1, col0, col1 = int(row0), int(row1), int(col0), int(col1)

    if kind == "image":
        import numpy as np
        obj = np.asarray(obj)
        kind = res["kind"] = "ndarray"

    if kind == "model":
        params = list(obj.named_parameters())
        bufs = list(obj.named_buffers())
        n = len(params) + len(bufs)
        rows, children = [], []
        for name, p in itertools.islice(itertools.chain(params, bufs), row0, row1):
            is_buf = len(rows) + row0 >= len(params)
            rows.append([name + (" (buffer)" if is_buf else ""), f"{tuple(p.shape)}", str(p.dtype).replace("torch.", ""),
                         bool(p.requires_grad) and not is_buf, str(p.device), int(p.numel())])
            children.append(summarize(name, p))
        res["nrows"], res["ncols"] = n, 6
        res["columns"] = ["parameter", "shape", "dtype", "grad", "device", "numel"]
        res["rows"] = rows
        res["children"] = children
        res["repr"] = _full_repr(obj, 4000)
        return _Payload(res)

    if kind in ("tensor", "jax", "ndarray", "xarray"):
        shape = tuple(int(s) for s in obj.shape)
        res["shape"] = list(shape)
        res["dtype"] = str(obj.dtype).replace("torch.", "")
        if kind == "xarray":
            res["dims"] = [str(d) for d in obj.dims]
        ndim = len(shape)
        try:
            if ndim == 0:
                win = _window_np(obj, kind, ())
                res["rows"] = [[_to_cell(win.item())]] if win.dtype.kind not in "Mm" else [[str(win)]]
                res["nrows"], res["ncols"] = 1, 1
            elif ndim == 1:
                res["nrows"], res["ncols"] = shape[0], 1
                res["rows"] = _cells_1d(_window_np(obj, kind, (slice(row0, row1),)))
            else:
                lead = tuple(int(i) for i in (index or [0] * (ndim - 2)))
                if len(lead) != ndim - 2 or any(not (0 <= i < s) for i, s in zip(lead, shape)):
                    res["error"] = f"index {list(lead)} out of range for shape {list(shape)}"
                    return _Payload(res)
                res["index"] = list(lead)
                res["nrows"], res["ncols"] = shape[-2], shape[-1]
                res["rows"] = _cells_2d(_window_np(obj, kind, lead + (slice(row0, row1), slice(col0, col1))))
        except Exception as e:  # noqa: BLE001
            res["error"] = f"cannot read window: {e!r}"
            return _Payload(res)
        res["row0"], res["col0"] = row0, col0
        return _Payload(res)

    if kind in ("dataframe", "polars", "series"):
        if kind == "series" and _is_polars_series(obj):
            n = len(obj)
            res["nrows"], res["ncols"] = n, 1
            res["columns"] = [str(obj.name)]
            res["dtypes"] = [str(obj.dtype)]
            res["index_labels"] = list(range(row0, min(row1, n)))
            res["rows"] = [[_to_cell(v)] for v in obj.slice(row0, max(0, row1 - row0)).to_list()]
            res["row0"], res["col0"] = row0, col0
            return _Payload(res)
        if kind == "polars":
            cols = list(obj.columns[col0:col1])
            win = obj.slice(row0, max(0, row1 - row0)).select(cols)
            res["nrows"], res["ncols"] = int(obj.shape[0]), int(obj.shape[1])
            res["columns"] = [str(c) for c in cols]
            res["dtypes"] = [str(t) for t in win.dtypes]
            res["index_labels"] = list(range(row0, min(row1, obj.shape[0])))
            res["rows"] = [[_to_cell(v) for v in r] for r in win.rows()]
            res["row0"], res["col0"] = row0, col0
            return _Payload(res)
        if kind == "series":
            win = obj.iloc[row0:row1]
            res["nrows"], res["ncols"] = int(len(obj)), 1
            res["columns"] = [str(obj.name)]
            res["dtypes"] = [str(obj.dtype)]
            res["index_labels"] = [_to_cell(i) for i in win.index.tolist()]
            res["rows"] = [[_to_cell(v)] for v in win.tolist()]
            res["row0"], res["col0"] = row0, col0
            return _Payload(res)
        df = obj
        res["nrows"], res["ncols"] = int(df.shape[0]), int(df.shape[1])
        res["columns"] = [str(c) for c in df.columns[col0:col1]]
        res["dtypes"] = [str(t) for t in df.dtypes.iloc[col0:col1]]
        win = df.iloc[row0:row1, col0:col1]
        res["index_labels"] = [_to_cell(i) for i in win.index.tolist()]
        res["rows"] = [[_to_cell(v) for v in r] for r in win.itertuples(index=False, name=None)]
        res["row0"], res["col0"] = row0, col0
        return _Payload(res)

    if kind in ("scalar", "text"):
        res["nrows"], res["ncols"] = 1, 1
        res["columns"] = ["value"]
        res["rows"] = [[_to_cell(obj) if kind == "scalar" else _to_cell(obj if isinstance(obj, str) else _short_repr(obj, _CELL_STR_MAX))]]
        res["repr"] = _full_repr(obj, 4000)
        return _Payload(res)

    if kind == "dict":
        items = list(itertools.islice(obj.items(), row0, row1))
        res["nrows"], res["ncols"] = len(obj), 2
        res["columns"] = ["key", "value"]
        res["rows"] = [[_to_cell(k), _to_cell(v)] for k, v in items]
        res["children"] = [summarize(_key_name(k, row0 + i), v) for i, (k, v) in enumerate(items)]
        res["row0"] = row0
        return _Payload(res)

    if kind == "sequence":
        n = len(obj)
        res["nrows"], res["ncols"] = n, 1
        res["columns"] = ["value"]
        if isinstance(obj, (set, frozenset)):
            items = list(itertools.islice(obj, row0, row1))
            res["rows"] = [[_to_cell(v)] for v in items]
            res["note"] = "set iteration order is not stable; elements cannot be addressed by index"
        else:
            items = obj[row0:row1]
            res["rows"] = [[_to_cell(v)] for v in items]
            res["children"] = [summarize(f"[{i}]", v) for i, v in enumerate(items, start=row0)]
        res["row0"] = row0
        return _Payload(res)

    if _is_xarray_dataset(obj):
        names = list(obj.data_vars)
        res["nrows"], res["ncols"] = len(names), 4
        res["columns"] = ["variable", "shape", "dtype", "dims"]
        rows, children = [], []
        for name in names[row0:row1]:
            v = obj[name]
            rows.append([str(name), str(tuple(int(s) for s in v.shape)), str(v.dtype), str(tuple(str(d) for d in v.dims))])
            children.append(summarize(_key_name(str(name), 0), v))
        res["rows"], res["children"] = rows, children
        res["repr"] = _full_repr(obj, 4000)
        res["row0"] = row0
        return _Payload(res)

    if _is_polars_lazy(obj):
        schema = _safe(lambda: obj.collect_schema(), None)
        if schema is None:
            schema = _safe(lambda: obj.schema, {}) or {}
        items = list(schema.items())
        res["nrows"], res["ncols"] = len(items), 2
        res["columns"] = ["column", "dtype"]
        res["rows"] = [[str(c), str(t)] for c, t in items[row0:row1]]
        res["note"] = "LazyFrame: schema only (not collected)"
        res["repr"] = _short_repr(obj, 2000)
        res["row0"] = row0
        return _Payload(res)

    # generic object: names first, then static lookups; getattr only for plain
    # data attributes inside the requested window.
    entries = []  # (name, static_value, how)  how: "value" | "getattr" | "property"
    _FUNC_TYPES = (types.FunctionType, types.MethodType, types.BuiltinFunctionType, types.BuiltinMethodType,
                   classmethod, staticmethod, types.MethodDescriptorType, types.WrapperDescriptorType,
                   types.ClassMethodDescriptorType, types.MethodWrapperType)
    for a in _safe(lambda: dir(obj), []):
        if not isinstance(a, str) or a.startswith("_"):
            continue
        try:
            sv = inspect.getattr_static(obj, a)
        except AttributeError:
            entries.append((a, None, "getattr"))  # dynamic (__getattr__); resolved lazily
            continue
        if isinstance(sv, _FUNC_TYPES):
            continue
        if isinstance(sv, types.MemberDescriptorType):
            entries.append((a, None, "getattr"))  # __slots__: safe and cheap
        elif hasattr(type(sv), "__get__") and not inspect.isclass(sv):
            entries.append((a, None, "property"))  # property / cached_property / custom descriptor
        elif callable(sv):
            continue
        else:
            entries.append((a, sv, "value"))
    res["nrows"], res["ncols"] = len(entries), 2
    res["columns"] = ["attribute", "value"]
    rows, children = [], []
    for a, sv, how in entries[row0:row1]:
        if how == "property":
            rows.append([a, "<property>"])
            children.append(_property_stub(a))
            continue
        v = sv if how == "value" else _safe(lambda: getattr(obj, a))
        rows.append([a, _to_cell(v)])
        children.append(summarize(a, v))
    res["rows"], res["children"] = rows, children
    res["repr"] = _full_repr(obj, 2000)
    res["row0"] = row0
    return _Payload(res)


# ----------------------------------------------------------------------------
# plots
# ----------------------------------------------------------------------------

def _as_numpy(obj):
    import numpy as np
    kind = _kind(obj)
    if kind == "tensor":
        t = obj.detach()
        if str(t.dtype) == "torch.bfloat16":
            t = t.float()
        return t.cpu().numpy()
    if kind in ("dataframe", "series", "polars"):
        return obj.to_numpy()
    if kind == "xarray":
        return obj.values
    return np.asarray(obj)


def _dt_to_ms(np, a):
    """datetime64/timedelta64 -> float64 epoch/duration milliseconds (NaT -> nan)."""
    nat = np.isnat(a)
    unit = "datetime64[ms]" if a.dtype.kind == "M" else "timedelta64[ms]"
    out = a.astype(unit).astype("int64").astype("float64")
    if nat.any():
        out[nat] = np.nan
    return out


def _nums(np, a):
    """1-D float array -> list with non-finite values as None (vectorized)."""
    a = np.asarray(a, dtype="float64")
    return np.where(np.isfinite(a), a, None).astype(object).tolist()


def _plot_payload(label, obj, max_points, heat_max=1000):
    import numpy as np
    kind = _kind(obj)
    cols = None
    x = None
    if kind in ("dataframe", "polars"):
        cols = [str(c) for c in obj.columns]
    elif kind == "series":
        cols = [str(obj.name)]
    if kind in ("dataframe", "series") and not _is_polars_series(obj):
        idx = _safe(lambda: obj.index.to_numpy())
        if idx is not None and getattr(idx.dtype, "kind", "") == "M":
            x = _dt_to_ms(np, idx)
    arr = _as_numpy(obj)
    res = {"path": label, "shape": list(arr.shape), "dtype": str(arr.dtype)}
    if arr.dtype.kind in "Mm":
        arr = _dt_to_ms(np, arr)
    elif arr.dtype.kind not in "biuf":
        try:
            arr = arr.astype("float64")
        except Exception:  # noqa: BLE001
            res["error"] = f"cannot plot dtype {arr.dtype}"
            return _Payload(res)
    if arr.ndim == 0:
        arr = arr.reshape(1)
    if arr.ndim == 1:
        step = max(1, arr.shape[0] // max_points)
        res["y"] = _nums(np, arr[::step])
        res["step"] = step
        if x is not None and x.shape[0] == arr.shape[0]:
            res["x"] = _nums(np, x[::step])
    elif arr.ndim == 2:
        rows, ncols = arr.shape
        if ncols <= 64:  # tall-and-narrow: columns are series, sample rows
            step = max(1, rows // max_points)
            arr = arr[::step]
            res["step"] = step
            if x is not None and x.shape[0] == rows:
                res["x"] = _nums(np, x[::step])
        else:  # heatmap: cap both axes
            s0 = -(-rows // heat_max) if rows > heat_max else 1
            s1 = -(-ncols // heat_max) if ncols > heat_max else 1
            arr = arr[::s0, ::s1]
            res["step"] = s0
        f = arr.astype("float64", copy=False)
        res["z"] = np.where(np.isfinite(f), f, None).astype(object).tolist()
        if cols:
            res["columns"] = cols
    else:
        res["error"] = f"{arr.ndim}-D arrays: select a 2-D slice first"
    return _Payload(res)


def plot_data(path, max_points=20000):
    """Numeric payload for quick plots from the workspace panel."""
    try:
        return _plot_payload(path, _resolve(path), int(max_points))
    except Exception as e:  # noqa: BLE001
        return _Payload({"path": path, "error": repr(e)})


# ----------------------------------------------------------------------------
# images and expression plots (stage 3)
# ----------------------------------------------------------------------------

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

    try:
        arr = _as_numpy(_resolve(path))
    except Exception as e:  # noqa: BLE001
        return _Payload({"path": path, "error": repr(e)})
    shape = list(arr.shape)
    if arr.ndim < 2:
        return _Payload({"path": path, "error": "need at least 2 dimensions"})
    if layout == "auto":
        lay, extra = _guess_layout(shape)
    elif layout in ("HW", "HWC", "CHW"):
        lay, extra = layout, len(shape) - (2 if layout == "HW" else 3)
    else:
        return _Payload({"path": path, "error": f"unknown layout {layout!r}"})
    if extra < 0:
        return _Payload({"path": path, "error": f"layout {lay} needs more dimensions than {shape}"})
    try:
        idx = tuple(int(i) for i in (index if index is not None else [0] * extra))
    except (TypeError, ValueError):
        return _Payload({"path": path, "error": f"bad index {index!r}"})
    if len(idx) != extra or any(not (0 <= i < s) for i, s in zip(idx, shape)):
        return _Payload({"path": path, "error": f"index {list(idx)} out of range for leading dims {shape[:extra]}"})
    view = arr[idx] if extra else arr
    if lay == "CHW":
        view = np.moveaxis(view, 0, -1)
    if lay in ("HWC", "CHW"):
        if view.shape[-1] == 1:
            view = view[..., 0]
            lay = "HW"
        elif view.shape[-1] == 4:
            view = view[..., :3]
        elif view.shape[-1] != 3:
            return _Payload({"path": path, "error": f"expected 1, 3 or 4 channels, got {view.shape[-1]}"})
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
    try:
        return _plot_payload(expr, _ns_eval(expr), int(max_points))
    except Exception as e:  # noqa: BLE001
        return _Payload({"path": expr, "error": repr(e)})


def run_file(path, argv=None):
    """Execute a script in the user namespace with its real filename, so
    tracebacks and debugger breakpoints refer to the file (like MATLAB's Run)."""
    ns = _namespace()
    with open(path, "rb") as f:
        src = f.read()
    code = compile(src, path, "exec", dont_inherit=True)  # bytes: honours the coding cookie
    script_dir = os.path.dirname(os.path.abspath(path))
    old_argv, old_file = sys.argv, ns.get("__file__")
    sys.argv = [path] + list(argv or [])
    ns["__file__"] = path
    sys.path.insert(0, script_dir)
    try:
        exec(code, ns)
    finally:
        if sys.path[:1] == [script_dir]:
            del sys.path[0]
        sys.argv = old_argv
        if old_file is None:
            ns.pop("__file__", None)
        else:
            ns["__file__"] = old_file


# ----------------------------------------------------------------------------
# file system access (used when the kernel runs on another machine)
# ----------------------------------------------------------------------------

def fs_list(path):
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
    try:
        p = os.path.expanduser(path)
        size = os.path.getsize(p)
        if size > _FS_READ_MAX:
            return _Payload({"path": path, "error": f"file is {size:,} bytes; limit is {_FS_READ_MAX:,}"})
        with open(p, encoding="utf-8", errors="replace") as f:
            return _Payload({"path": path, "text": f.read()})
    except (OSError, ValueError) as e:
        return _Payload({"path": path, "error": str(e)})


def fs_write(path, b64):
    import base64
    try:
        p = os.path.expanduser(path)
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        data = base64.b64decode(b64)
        with open(p, "wb") as f:
            f.write(data)
        return _Payload({"path": path, "ok": True})
    except (OSError, ValueError) as e:  # binascii.Error is a ValueError
        return _Payload({"path": path, "error": str(e)})


def fs_info():
    import socket
    return _Payload({"cwd": os.getcwd(), "home": os.path.expanduser("~"), "host": socket.gethostname(), "sep": os.sep})
