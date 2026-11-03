import json, numpy as np, pandas as pd, sys
sys.path.insert(0, __file__.rsplit("/", 2)[0])
import pide_kernel as k
a = np.random.rand(3, 4, 5); df = pd.DataFrame({"x": [1, 2, 3], "y": ["a", "b", "c"]})
d = {"n": 1, "l": [1, 2, 3]}
snap = k.snapshot()._repr_mimebundle_()[k.MIME]
print(json.dumps([v for v in snap["variables"] if v["name"] in ("a", "df", "d")], indent=1)[:900])
print(json.dumps(k.detail("a", index=[1])._repr_mimebundle_()[k.MIME])[:300])
print(json.dumps(k.detail("df")._repr_mimebundle_()[k.MIME])[:300])
print(json.dumps(k.detail("d")._repr_mimebundle_()[k.MIME])[:300])
