"""Tests for pide_kernel (the in-kernel helper).

Runs with or without the optional libraries (torch/polars/xarray/PIL): tests
that need one are skipped when it is missing.
"""
import importlib
import json
import math
import os
import sys
import time
import types

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pide_kernel as k  # noqa: E402


def payload(p):
    """Unwrap a _Payload and assert that it is strict JSON."""
    bundle = p._repr_mimebundle_()
    data = bundle[k.MIME]
    json.dumps(data, allow_nan=False)  # raises on NaN/inf/non-JSON types
    return data


@pytest.fixture
def ns(monkeypatch):
    d = {}
    monkeypatch.setattr(k, "_namespace", lambda: d)
    k._STATS_CACHE.clear()
    return d


def by_name(snap):
    return {v["name"]: v for v in snap["variables"]}


# ----------------------------------------------------------------------------
# snapshot
# ----------------------------------------------------------------------------

def test_snapshot_basic_kinds(ns):
    ns.update({
        "a": np.arange(12.0).reshape(3, 4),
        "df": pd.DataFrame({"x": [1, 2, 3], "y": ["a", "b", "c"]}),
        "s": pd.Series([1.0, np.nan, 3.0]),
        "d": {"n": 1, "l": [1, 2, 3]},
        "l": [1, 2, 3],
        "big": list(range(50_000)),
        "txt": "x" * 10_000,
        "f": 1.5,
        "npf": np.float32(2.5),
        "npd": np.datetime64("2020-01-01"),
        "ib": np.array([True, False, True]),
        "ii": np.array([1, 2, 3], dtype="int8"),
        "nan_only": np.array([np.nan, np.nan]),
        "In": [], "_hidden": 1, 42: "non-str name",
    })
    snap = payload(k.snapshot())
    assert "error" not in snap
    v = by_name(snap)
    assert "In" not in v and "_hidden" not in v and 42 not in v
    assert v["a"]["kind"] == "ndarray" and v["a"]["shape"] == [3, 4]
    assert v["a"]["stats"] == {"min": 0.0, "max": 11.0, "mean": 5.5, "nan": 0}
    assert v["df"]["kind"] == "dataframe" and v["df"]["columns"] == ["x", "y"]
    assert v["s"]["kind"] == "series" and v["s"]["stats"] == {"min": 1.0, "max": 3.0, "mean": 2.0, "nan": 1}
    assert v["d"]["kind"] == "dict" and v["d"]["len"] == 2 and v["d"]["value"] == "{'n': 1, 'l': [1, 2, 3]}"
    assert v["l"]["kind"] == "sequence" and v["l"]["value"] == "[1, 2, 3]"
    assert v["big"]["value"].startswith("<list of 50000 items> [0, 1, 2")
    assert "..." in v["big"]["value"] and len(v["big"]["value"]) <= 120
    assert v["txt"]["kind"] == "text" and v["txt"]["len"] == 10_000 and len(v["txt"]["value"]) <= 121
    assert v["f"]["kind"] == "scalar" and v["f"]["value"] == "1.5"
    assert v["npf"]["kind"] == "scalar" and v["npf"]["value"] == "2.5" and v["npf"]["dtype"] == "float32"
    assert v["npd"]["kind"] == "scalar" and v["npd"]["value"] == "2020-01-01"
    assert v["ib"]["stats"]["true"] == 2 and v["ib"]["stats"]["min"] == 0
    assert v["ii"]["stats"] == {"min": 1, "max": 3, "mean": 2.0, "nan": 0}
    assert v["nan_only"]["stats"] == {"min": None, "max": None, "mean": None, "nan": 2}


def test_snapshot_object_kind_shows_qualname(ns):
    class Plain:
        pass

    class WithRepr:
        def __repr__(self):
            return "WithRepr(" + "x" * 500 + ")"

    ns["p"], ns["r"] = Plain(), WithRepr()
    v = by_name(payload(k.snapshot()))
    assert v["p"]["value"].endswith("Plain>")
    assert "WithRepr · WithRepr(xxx" in v["r"]["value"] and len(v["r"]["value"]) < 160


def test_snapshot_survives_hostile_objects(ns):
    class Boom:
        def __repr__(self):
            raise RuntimeError("no repr")

        @property
        def __class__(self):
            raise RuntimeError("no class")

    ns["b"] = Boom()
    snap = payload(k.snapshot())
    assert "error" not in snap
    assert snap["variables"][0]["name"] == "b"


def test_snapshot_returns_error_payload_when_namespace_fails(monkeypatch):
    def broken():
        raise RuntimeError("no namespace")

    monkeypatch.setattr(k, "_namespace", broken)
    snap = payload(k.snapshot())
    assert snap["variables"] == [] and "RuntimeError" in snap["error"]


def test_short_repr_is_cheap_for_huge_containers():
    big = {i: i for i in range(2_000_000)}
    t = time.perf_counter()
    s = k._short_repr(big)
    assert time.perf_counter() - t < 0.2
    assert s.startswith("<dict of 2000000 items> {0: 0, 1: 1")
    s = k._short_repr(set(range(1_000_000)))
    assert s.startswith("<set of 1000000 items>")
    assert k._short_repr("ab\ncd" * 100, 20).endswith("…")


def test_payload_rejects_invalid_json():
    assert "error" in k._Payload({"x": float("nan")})._repr_mimebundle_()[k.MIME]
    assert k._Payload({"x": {1, 2}})._repr_mimebundle_()[k.MIME] == {"x": "{1, 2}"}  # default=str
    # numpy scalars are converted rather than rejected
    assert k._Payload({"x": np.int64(5)})._repr_mimebundle_()[k.MIME] == {"x": 5}


# ----------------------------------------------------------------------------
# _resolve / child paths
# ----------------------------------------------------------------------------

def test_resolve_dict_keys_with_dots_quotes_and_nested_lists(ns):
    d = {"a.b": 1, 'q"x': [10, [20, 30]], (1, 2): "tuple-key", 3: "three", "s": {"t": [1, 2]}}
    ns["d"] = d
    assert k._resolve('d["a.b"]') == 1
    assert k._resolve('d["q\\"x"][1][1]') == 30
    assert k._resolve("d[#2]") == "tuple-key"
    assert k._resolve("d[3]") == "three"
    assert k._resolve("d['a.b']") == 1  # legacy quoted form
    assert k._resolve('d["s"]["t"][0]') == 1
    assert k._resolve('d["s"].t[1]') == 2  # [key] falls back to getattr and vice versa

    # child names emitted by detail() round-trip through _resolve
    det = payload(k.detail("d"))
    for child, (key, val) in zip(det["children"], d.items()):
        assert k._resolve("d" + child["name"]) is val


def test_resolve_legacy_dot_index_and_attributes(ns):
    class Obj:
        items = [[1, 2], [3, 4]]

    ns["o"] = Obj()
    ns["l"] = [[1, 2], [3, 4]]
    assert k._resolve("o.items.1.0") == 3  # digits after a dot index
    assert k._resolve("o.items[1][0]") == 3
    assert k._resolve("l.0") == [1, 2]


def test_resolve_errors_are_value_errors(ns):
    ns["d"] = {"a": [1]}
    for bad in ("nope", 'd["zz"]', "d.a[5]", 'd["a"].missing', "d[", "d[#9]", 'd["a"]["x"]'):
        with pytest.raises(ValueError):
            k._resolve(bad)


# ----------------------------------------------------------------------------
# detail windows
# ----------------------------------------------------------------------------

def test_detail_list_window(ns):
    ns["l"] = list(range(1000))
    r = payload(k.detail("l", row0=100, row1=110))
    assert r["nrows"] == 1000 and r["rows"] == [[i] for i in range(100, 110)]
    assert [c["name"] for c in r["children"]] == [f"[{i}]" for i in range(100, 110)]
    assert r["row0"] == 100


def test_detail_dict_window_and_set(ns):
    ns["d"] = {i: str(i) for i in range(500)}
    r = payload(k.detail("d", row0=10, row1=13))
    assert r["nrows"] == 500 and r["rows"] == [[10, "10"], [11, "11"], [12, "12"]]
    assert [c["name"] for c in r["children"]] == ["[10]", "[11]", "[12]"]
    ns["s"] = frozenset(range(5))
    r = payload(k.detail("s", row0=1, row1=3))
    assert r["nrows"] == 5 and len(r["rows"]) == 2 and "children" not in r and "note" in r


def test_detail_ndarray_windows(ns):
    ns["a"] = np.arange(3 * 4 * 5).reshape(3, 4, 5)
    r = payload(k.detail("a", index=[1], row0=1, row1=3, col0=2, col1=4))
    assert r["nrows"] == 4 and r["ncols"] == 5 and r["index"] == [1]
    assert r["rows"] == [[27, 28], [32, 33]]
    assert "error" in payload(k.detail("a", index=[7]))
    ns["v"] = np.array([1.0, np.nan, np.inf])
    assert payload(k.detail("v"))["rows"] == [[1.0], [None], ["inf"]]
    ns["z"] = np.float64(2.0)
    assert payload(k.detail("z"))["rows"] == [[2.0]]
    ns["i"] = 7
    assert payload(k.detail("i"))["rows"] == [[7]]
    ns["txt"] = "hello"
    assert payload(k.detail("txt"))["rows"] == [["hello"]]


def test_detail_dataframe_window(ns):
    ns["df"] = pd.DataFrame({"a": range(10), "b": [str(i) for i in range(10)], "c": np.linspace(0, 1, 10)},
                            index=pd.date_range("2021-01-01", periods=10))
    r = payload(k.detail("df", row0=2, row1=4, col0=1, col1=3))
    assert r["nrows"] == 10 and r["ncols"] == 3 and r["columns"] == ["b", "c"]
    assert r["rows"] == [["2", pytest.approx(2 / 9)], ["3", pytest.approx(3 / 9)]]
    assert r["index_labels"] == ["2021-01-03 00:00:00", "2021-01-04 00:00:00"]
    ns["s"] = pd.Series([1, None, 3], dtype="Int64", name="n")
    r = payload(k.detail("s"))
    assert r["rows"] == [[1], [None], [3]] and r["columns"] == ["n"]


def test_detail_datetime64_rendering(ns):
    ns["t"] = np.array(["2020-01-01T12:00", "NaT", "2021-06-30"], dtype="datetime64[ns]")
    ns["td"] = np.array([1, 2], dtype="timedelta64[D]")
    ns["t2"] = np.array([["2020-01-01", "2020-01-02"]], dtype="datetime64[D]")
    r = payload(k.detail("t"))
    assert r["rows"][0] == ["2020-01-01T12:00:00.000000000"] and r["rows"][1] == ["NaT"]
    assert payload(k.detail("td"))["rows"] == [["1 days"], ["2 days"]]
    assert payload(k.detail("t2"))["rows"] == [["2020-01-01", "2020-01-02"]]


def test_detail_generic_object_skips_properties_and_methods(ns):
    class Foo:
        cls_attr = "c"

        def __init__(self):
            self.x = 1
            self.long = "y" * 5000

        @property
        def expensive(self):
            raise RuntimeError("must not be evaluated")

        def method(self):
            pass

    ns["f"] = Foo()
    r = payload(k.detail("f"))
    rows = dict(r["rows"])
    assert rows == {"cls_attr": "c", "expensive": "<property>", "x": 1, "long": "y" * 1000 + "…"}
    assert "method" not in rows
    assert [c["name"] for c in r["children"]] == [row[0] for row in r["rows"]]
    r = payload(k.detail("f", row0=1, row1=2))
    assert r["nrows"] == 4 and len(r["rows"]) == 1


# ----------------------------------------------------------------------------
# stats
# ----------------------------------------------------------------------------

def test_array_stats_approx_flag_and_cache(ns):
    a = np.ones(12_000_000, dtype="int8")
    a[0] = -5
    st = k._array_stats(a)
    assert st["approx"] is True and st["min"] == -5 and st["max"] == 1 and st["nan"] == 0
    assert k._array_stats(a) is st  # cache hit
    a[0] = 7  # in-place edit changes the fingerprint
    assert k._array_stats(a)["min"] == 1
    small = np.array([1.0, np.nan, 3.0])
    assert k._array_stats(small) == {"min": 1.0, "max": 3.0, "mean": 2.0, "nan": 1}
    assert "approx" not in k._array_stats(small)


def test_array_stats_skips_memmap_and_noncontiguous_huge(tmp_path):
    p = tmp_path / "m.dat"
    mm = np.memmap(str(p), dtype="float64", mode="w+", shape=(100,))
    assert k._array_stats(mm) is None
    assert k._array_stats(mm[10:20]) is None  # base is a memmap
    huge = np.ones((12_000_000, 2), dtype="int8")[:, 0]  # non-contiguous view, > cap
    st = k._array_stats(huge)  # sampled through a strided view
    assert st["approx"] is True and st["max"] == 1
    assert k._array_stats(np.array([], dtype="float64")) is None
    assert k._array_stats(np.array(["a", "b"])) is None


def test_stats_budget_stops_after_deadline(ns):
    ns.update({f"a{i}": np.random.rand(10) + i for i in range(5)})
    k._DEADLINE[0] = time.monotonic() - 1  # already expired: nothing computed
    try:
        assert k._array_stats(ns["a0"]) is None
    finally:
        k._DEADLINE[0] = None
    assert k._array_stats(ns["a0"]) is not None
    # snapshot resets the deadline afterwards
    payload(k.snapshot())
    assert k._DEADLINE[0] is None


def test_pandas_series_stats_dtype_guards(ns):
    assert k._pandas_series_stats(pd.Series(["a", "b"])) is None
    assert k._pandas_series_stats(pd.Series(pd.date_range("2020", periods=3))) is None
    assert k._pandas_series_stats(pd.Series([1, None, 3], dtype="Int64")) == {"min": 1.0, "max": 3.0, "mean": 2.0, "nan": 1}
    assert k._pandas_series_stats(pd.Series([True, False, True])) ["true"] == 2


# ----------------------------------------------------------------------------
# plots
# ----------------------------------------------------------------------------

def test_plot_data_sampling(ns):
    ns["y"] = np.arange(100_000, dtype="float64")
    ns["y"][5] = np.nan
    r = payload(k.plot_data("y"))
    assert r["step"] == 5 and len(r["y"]) == 20_000 and r["y"][1] is None
    ns["tall"] = np.ones((100_000, 3))
    r = payload(k.plot_data("tall"))
    assert r["step"] == 5 and len(r["z"]) == 20_000 and len(r["z"][0]) == 3
    ns["wide"] = np.ones((2500, 1500))
    r = payload(k.plot_data("wide"))
    assert len(r["z"]) <= 1000 and len(r["z"][0]) <= 1000
    ns["small2d"] = np.ones((900, 200))  # within both caps: untouched
    r = payload(k.plot_data("small2d"))
    assert len(r["z"]) == 900 and len(r["z"][0]) == 200 and r["step"] == 1
    ns["s"] = np.array(["a", "b"])
    assert "error" in payload(k.plot_data("s"))
    ns["three"] = np.ones((2, 2, 2))
    assert "error" in payload(k.plot_data("three"))
    assert "error" in payload(k.plot_data("missing"))


def test_plot_data_datetime(ns):
    ns["t"] = np.array(["1970-01-01T00:00:01", "NaT"], dtype="datetime64[ns]")
    r = payload(k.plot_data("t"))
    assert r["y"] == [1000.0, None]
    ns["s"] = pd.Series([1.0, 2.0], index=pd.to_datetime(["1970-01-01", "1970-01-02"]))
    r = payload(k.plot_data("s"))
    assert r["y"] == [1.0, 2.0] and r["x"] == [0.0, 86_400_000.0]
    ns["df"] = pd.DataFrame({"a": [1, 2], "b": [3.0, np.nan]})
    r = payload(k.plot_expr("df"))
    assert r["z"] == [[1.0, 3.0], [2.0, None]] and r["columns"] == ["a", "b"]


# ----------------------------------------------------------------------------
# run_file / fs / image
# ----------------------------------------------------------------------------

def test_run_file_honours_coding_cookie_and_restores_state(ns, tmp_path):
    script = tmp_path / "script.py"
    script.write_bytes(b"# -*- coding: latin-1 -*-\nimport sys\ns = 'caf\xe9'\nfirst = sys.path[0]\nargs = list(sys.argv)\n")
    old_argv, old_path = list(sys.argv), list(sys.path)
    k.run_file(str(script), argv=["--x"])
    assert ns["s"] == "café"
    assert ns["first"] == str(tmp_path) and ns["args"] == [str(script), "--x"]
    assert "__file__" not in ns
    assert sys.argv == old_argv and sys.path == old_path
    bad = tmp_path / "bad.py"
    bad.write_text("raise RuntimeError('x')\n")
    with pytest.raises(RuntimeError):
        k.run_file(str(bad))
    assert sys.path == old_path and sys.argv == old_argv


def test_fs_read_cap_and_fs_write_errors(tmp_path, monkeypatch):
    f = tmp_path / "a.txt"
    f.write_text("hello")
    assert payload(k.fs_read(str(f)))["text"] == "hello"
    monkeypatch.setattr(k, "_FS_READ_MAX", 3)
    assert "error" in payload(k.fs_read(str(f)))
    assert "error" in payload(k.fs_read(str(tmp_path / "missing")))
    assert "error" in payload(k.fs_write(str(tmp_path / "out.bin"), "not base64!!"))
    assert payload(k.fs_write(str(tmp_path / "sub" / "out.bin"), "aGk="))["ok"] is True
    assert (tmp_path / "sub" / "out.bin").read_bytes() == b"hi"


def test_image_validates_index(ns):
    ns["a"] = np.random.rand(2, 5, 8, 9)
    r = payload(k.image("a", index=[1, 2]))
    assert r["h"] == 8 and r["w"] == 9 and r["channels"] == 1
    assert "error" in payload(k.image("a", index=[1]))
    assert "error" in payload(k.image("a", index=[1, 5]))
    assert "error" in payload(k.image("a", index=["x", 0]))
    ns["v"] = np.arange(3)
    assert "error" in payload(k.image("v"))
    assert "error" in payload(k.image("nope"))


# ----------------------------------------------------------------------------
# library detection without speculative imports
# ----------------------------------------------------------------------------

def test_nn_module_detection_does_not_import_torch(ns, monkeypatch):
    saved = {m: sys.modules[m] for m in list(sys.modules) if m == "torch" or m.startswith("torch.")}
    for m in saved:
        monkeypatch.delitem(sys.modules, m)
    monkeypatch.setitem(sys.modules, "torch", None)  # makes ``import torch`` fail loudly

    class FakeModule:
        pass

    ns["m"] = FakeModule()
    assert k._is_nn_module(ns["m"]) is False
    assert k._is_torch(ns["m"]) is False
    v = by_name(payload(k.snapshot()))
    assert v["m"]["kind"] == "object"
    assert sys.modules.get("torch") is None

    # a loaded torch (faked here) is used via isinstance, so subclasses are recognised
    fake = types.ModuleType("torch")
    fake.nn = types.SimpleNamespace(Module=FakeModule)
    monkeypatch.setitem(sys.modules, "torch", fake)

    class Net(FakeModule):
        pass

    assert k._is_nn_module(Net()) is True
    assert k._is_nn_module(object()) is False


def test_pandas_detection_uses_isinstance_for_subclasses(ns):
    class MyFrame(pd.DataFrame):
        pass

    ns["g"] = MyFrame({"a": [1, 2]})
    v = by_name(payload(k.snapshot()))
    assert v["g"]["kind"] == "dataframe"


def test_to_cell_numpy_and_pandas_values():
    assert k._to_cell(np.int64(3)) == 3
    assert k._to_cell(np.float32("nan")) is None
    assert k._to_cell(np.datetime64("2020-01-01")) == "2020-01-01"
    assert k._to_cell(np.datetime64("NaT", "ns")) == "NaT"
    assert k._to_cell(pd.NaT) is None and k._to_cell(pd.NA) is None
    assert k._to_cell(pd.Timestamp("2020-01-01 10:00")) == "2020-01-01 10:00:00"
    assert k._to_cell(2**60) == str(2**60)
    assert k._to_cell("x" * 2000).endswith("…") and len(k._to_cell("x" * 2000)) == 1001


# ----------------------------------------------------------------------------
# optional libraries
# ----------------------------------------------------------------------------

def test_torch_stats_and_paths(ns):
    torch = pytest.importorskip("torch")
    import torch.nn as nn

    t = torch.arange(10.0)
    st = k._tensor_stats(t)
    assert st == {"min": 0.0, "max": 9.0, "mean": 4.5, "nan": 0}
    assert k._tensor_stats(t) is st  # cache hit
    t[0] = 100.0  # _version bump invalidates the cache
    assert k._tensor_stats(t)["max"] == 100.0
    h = torch.tensor([1.0, float("nan"), 3.0], dtype=torch.float16)
    assert k._tensor_stats(h) == {"min": 1.0, "max": 3.0, "mean": 2.0, "nan": 1}
    assert k._tensor_stats(torch.tensor([1 + 2j])) is None
    assert k._tensor_stats(torch.tensor([True, False]))["true"] == 1
    assert k._tensor_stats(torch.tensor([1, 2, 3]))["mean"] == 2.0

    ns["seq"] = nn.Sequential(nn.Linear(2, 3), nn.ReLU())
    ns["md"] = nn.ModuleDict({"enc": nn.Linear(1, 1)})
    assert k._resolve("seq.0.weight") is ns["seq"][0].weight
    assert k._resolve("seq[0].weight") is ns["seq"][0].weight
    assert k._resolve('md["enc"].bias') is ns["md"]["enc"].bias
    r = payload(k.detail("seq"))
    assert r["kind"] == "model" and r["nrows"] == 2 and r["columns"][0] == "parameter"
    assert all(k._resolve("seq." + c["name"]) is not None for c in r["children"])
    v = by_name(payload(k.snapshot()))
    assert v["seq"]["kind"] == "model" and v["seq"]["params"] == 9
    ns["bf"] = torch.randn(2, 3, dtype=torch.bfloat16)
    r = payload(k.detail("bf"))
    assert r["nrows"] == 2 and r["ncols"] == 3


def test_polars_detail_and_stats(ns):
    pl = pytest.importorskip("polars")
    ns["df"] = pl.DataFrame({"a": [1, 2, 3, 4], "b": ["x", "y", "z", "w"], "c": [1.0, None, 3.0, 4.0]})
    r = payload(k.detail("df", row0=1, row1=3, col0=1, col1=3))
    assert r["nrows"] == 4 and r["ncols"] == 3 and r["columns"] == ["b", "c"]
    assert r["rows"] == [["y", None], ["z", 3.0]] and r["dtypes"] == ["String", "Float64"]
    ns["lz"] = ns["df"].lazy().select(pl.col("a") * 2)
    r = payload(k.detail("lz"))
    assert r["rows"] == [["a", "Int64"]] and "note" in r
    ns["s"] = ns["df"]["c"]
    v = by_name(payload(k.snapshot()))
    assert v["s"]["stats"] == {"min": 1.0, "max": 4.0, "mean": pytest.approx(8 / 3), "nan": 0, "null": 1}
    assert v["lz"]["kind"] == "object"
    assert k._polars_series_stats(ns["df"]["b"]) is None


def test_xarray_dataset_detail_and_backing(ns):
    xr = pytest.importorskip("xarray")
    da = xr.DataArray(np.arange(6.0).reshape(2, 3), dims=("y", "x"), name="t")
    ns["ds"] = xr.Dataset({"temp": da, "label": xr.DataArray(np.array(["a", "b"]), dims=("y",))})
    ns["da"] = da
    v = by_name(payload(k.snapshot()))
    assert v["da"]["kind"] == "xarray" and v["da"]["stats"]["max"] == 5.0 and v["da"]["dims"] == ["y", "x"]
    r = payload(k.detail("ds"))
    assert r["columns"][0] == "variable" and r["rows"][0][0] == "temp"
    assert all(k._resolve("ds" + c["name"]) is not None for c in r["children"])
    r = payload(k.detail("da", row0=0, row1=1))
    assert r["rows"] == [[0.0, 1.0, 2.0]] and r["dims"] == ["y", "x"]
    assert k._xarray_backing(da) is da.variable._data


def test_pil_image(ns):
    Image = pytest.importorskip("PIL.Image")
    ns["img"] = Image.new("RGB", (4, 3))
    v = by_name(payload(k.snapshot()))
    assert v["img"]["kind"] == "image" and v["img"]["shape"] == [3, 4]
    r = payload(k.detail("img"))
    assert r["kind"] == "ndarray" and r["shape"] == [3, 4, 3]
    assert payload(k.image("img"))["channels"] == 3


def test_everything_in_snapshot_and_detail_is_json(ns):
    ns.update({
        "a": np.array([np.inf, -np.inf, np.nan]),
        "o": object(),
        "d": {"k": np.float64("nan"), np.int64(1): {1, 2}},
        "t": (1, "x", None, 2.5, b"bytes"),
        "mod": importlib.import_module("json"),
        "cls": dict,
        "fn": lambda x: x,
        "c": 1 + 2j,
    })
    snap = payload(k.snapshot())
    assert len(snap["variables"]) == len(ns)
    for name in ns:
        payload(k.detail(name))
    payload(k.fs_info())
    payload(k.fs_list(os.path.dirname(__file__)))


def test_fs_crlf_roundtrip_nonutf8_and_atomic_write(tmp_path):
    import base64, os, stat
    f = tmp_path / "crlf.txt"
    f.write_bytes(b"a\r\nb\r\n")
    text = payload(k.fs_read(str(f)))["text"]
    assert text == "a\r\nb\r\n"
    f.chmod(0o640)
    assert payload(k.fs_write(str(f), base64.b64encode(text.encode()).decode()))["ok"] is True
    assert f.read_bytes() == b"a\r\nb\r\n"
    if os.name != "nt":  # Windows has no POSIX permission bits
        assert stat.S_IMODE(os.stat(f).st_mode) == 0o640
    assert [p.name for p in tmp_path.iterdir()] == ["crlf.txt"]  # no temp left behind
    bad = tmp_path / "latin.txt"
    bad.write_bytes(b"caf\xe9")
    assert "UTF-8" in payload(k.fs_read(str(bad)))["error"]


# ----------------------------------------------------------------------------
# review round: stale stats, bounded reprs, image slicing, PIL modes, masks
# ----------------------------------------------------------------------------

def test_stats_see_inplace_edits_and_noncontiguous(ns):
    a = np.zeros(1000)
    ns["a"] = a
    assert by_name(payload(k.snapshot()))["a"]["stats"]["max"] == 0
    a[5] = 100
    assert by_name(payload(k.snapshot()))["a"]["stats"]["max"] == 100
    m = np.zeros((100, 100))
    ns["v"] = m[:, ::2]
    assert by_name(payload(k.snapshot()))["v"]["stats"]["max"] == 0
    m[3, 4] = 7
    assert by_name(payload(k.snapshot()))["v"]["stats"]["max"] == 7
    s = pd.Series(np.zeros(500))
    ns["s"] = s
    by_name(payload(k.snapshot()))
    s.iloc[7] = 9.0
    assert by_name(payload(k.snapshot()))["s"]["stats"]["max"] == 9.0


def test_big_array_fingerprint_detects_edit_at_sample_point(ns):
    a = np.zeros(2_000_000)
    ns["a"] = a
    by_name(payload(k.snapshot()))
    a[:] = 1.0
    assert by_name(payload(k.snapshot()))["a"]["stats"]["min"] == 1.0


def test_bounded_reprs(ns):
    import array
    import collections
    ba = bytearray(20_000_000)
    ns.update({
        "ba": ba,
        "arr": array.array("i", range(100_000)),
        "keys": dict.fromkeys(range(100_000)).keys(),
        "ul": collections.UserList(range(100_000)),
        "ud": collections.UserDict({i: i for i in range(100_000)}),
        "mp": types.MappingProxyType({i: i for i in range(100_000)}),
        "dq": collections.deque(range(100_000)),
    })

    class Big:
        def __len__(self):
            return 10**9

        def __repr__(self):
            raise AssertionError("repr must not be called")

    ns["big"] = Big()
    t0 = time.time()
    v = by_name(payload(k.snapshot()))
    assert time.time() - t0 < 2
    for n in ("ba", "arr", "keys", "ul", "ud", "mp", "dq", "big"):
        assert len(v[n]["value"]) <= 200, n
    assert v["dq"]["kind"] == "sequence"
    assert "items" in v["big"]["value"]
    payload(k.detail("dq", row0=5, row1=8))
    assert payload(k.detail("dq", row0=5, row1=8))["rows"] == [[5], [6], [7]]
    assert len(payload(k.detail("ba"))["repr"]) <= 4000


def test_slow_repr_type_is_skipped_after_first_time(ns):
    class Slow:
        calls = 0

        def __repr__(self):
            Slow.calls += 1
            time.sleep(0.08)
            return "slow!"

    k._SLOW_REPR.discard(Slow)
    ns["a"], ns["b"] = Slow(), Slow()
    v = by_name(payload(k.snapshot()))
    assert Slow.calls == 1  # b is skipped because a already proved slow
    assert v["b"]["value"] == "<Slow>" or "Slow" in v["b"]["value"]
    k.snapshot()
    assert Slow.calls == 1
    k._SLOW_REPR.discard(Slow)


def test_torch_conj_and_neg_bits(ns):
    torch = pytest.importorskip("torch")
    t = torch.tensor([[1 + 2j, 3 - 1j]]).conj()
    assert np.allclose(k._as_numpy(t), np.array([[1 - 2j, 3 + 1j]]))
    ns["t"] = t
    r = payload(k.detail("t"))
    assert "error" not in r
    tn = torch.tensor([[1.0, -2.0]]).conj_physical()
    ns["tn"] = tn
    assert "error" not in payload(k.detail("tn"))


def test_torch_int64_stats_exact(ns):
    torch = pytest.importorskip("torch")
    big = 2**62 + 1
    ns["t"] = torch.tensor([big, 5], dtype=torch.int64)
    st = by_name(payload(k.snapshot()))["t"]["stats"]
    assert st["max"] == str(big) and st["min"] == 5


def test_image_slices_before_converting(ns):
    torch = pytest.importorskip("torch")
    t = torch.arange(3 * 4 * 6 * 6, dtype=torch.float32).reshape(3, 4, 6, 6)
    ns["t"] = t
    r = payload(k.image("t", index=[2, 1]))
    assert r["h"] == 6 and r["w"] == 6 and r["dtype"] == "float32"
    r = payload(k.image("t", index=[2, 1], max_px=9))
    assert r["step"] == 2 and r["h"] == 3


def test_pil_modes(ns):
    Image = pytest.importorskip("PIL.Image")
    ns["la"] = Image.new("LA", (5, 4), (10, 200))
    ns["cmyk"] = Image.new("CMYK", (5, 4), (0, 0, 0, 255))
    ns["p"] = Image.new("P", (5, 4), 3)
    ns["ycc"] = Image.new("YCbCr", (5, 4))
    ns["l"] = Image.new("L", (5, 4), 7)
    r = payload(k.image("la"))
    assert r["shape"] == [4, 5, 4] and r["channels"] == 3
    assert payload(k.detail("la"))["shape"] == [4, 5, 4]
    assert payload(k.image("cmyk"))["shape"] == [4, 5, 3]
    assert payload(k.image("p"))["shape"] == [4, 5, 3]
    assert payload(k.image("ycc"))["shape"] == [4, 5, 3]
    assert payload(k.image("l"))["channels"] == 1


def test_guess_layout():
    assert k._guess_layout((4, 28, 28)) == ("HW", 1)  # gray batch, not RGBA
    assert k._guess_layout((3, 28, 28)) == ("CHW", 0)
    assert k._guess_layout((1, 28, 28)) == ("CHW", 0)
    assert k._guess_layout((10, 4, 28, 28)) == ("CHW", 1)
    assert k._guess_layout((28, 28, 3)) == ("HWC", 0)
    assert k._guess_layout((5, 8, 9)) == ("HW", 1)


def test_masked_array_cells_are_none(ns):
    m = np.ma.masked_array([[1.0, 2.0], [3.0, 4.0]], mask=[[0, 1], [0, 0]])
    ns["m"] = m
    assert payload(k.detail("m"))["rows"] == [[1.0, None], [3.0, 4.0]]
    ns["m1"] = np.ma.masked_array([1, 2, 3], mask=[0, 0, 1])
    assert payload(k.detail("m1"))["rows"] == [[1], [2], [None]]
    ns["m0"] = np.ma.masked_array(5, mask=True)
    assert payload(k.detail("m0"))["rows"] == [[None]]


def test_xarray_dataset_nonstr_names(ns):
    xr = pytest.importorskip("xarray")
    ds = xr.Dataset({1: ("x", [1, 2, 3]), 2: ("x", [4, 5, 6])})
    ns["ds"] = ds
    r = payload(k.detail("ds"))
    for c in r["children"]:
        assert k._resolve("ds" + c["name"]) is not None


def test_plot_payload_contract(ns):
    idx = pd.date_range("2020-01-01", periods=10, freq="D")
    ns["s"] = pd.Series(np.arange(10.0), index=idx)
    r = payload(k.plot_data("s", max_points=4))
    assert r["step"] == 3 and len(r["y"]) == 4 and len(r["x"]) == 4  # ceil: <= max_points
    ns["wide"] = pd.DataFrame(np.zeros((3, 2500)), columns=[f"c{i}" for i in range(2500)])
    r = payload(k.plot_data("wide"))
    assert len(r["columns"]) == len(r["z"][0]) and r["step1"] == 3
    ns["c"] = np.array([1 + 1j, 2 + 0j])
    assert payload(k.plot_data("c"))["y"] == [1.0, 2.0]


def test_longdouble_cell(ns):
    ns["x"] = np.longdouble("1.5")
    assert by_name(payload(k.snapshot()))["x"]["value"] == "1.5"
    assert payload(k.detail("x"))["rows"] == [[1.5]]
