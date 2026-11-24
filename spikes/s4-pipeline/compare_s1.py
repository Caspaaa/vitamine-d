"""Compare tiles from this pipeline with the S1 prototype tiles (same area, built from a 3x3 km mosaic).

  python compare_s1.py [--kind dsm dtm]
Differences are reported in 0.25 m steps. Tiles close to the edge of the S1 mosaic (or of a partial run here) differ
legitimately, so they are listed separately.
"""
import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
OUT = Path(os.environ.get("OUT_DIR", HERE / "out"))
S1 = HERE.parent / "s1-shadow" / "web" / "public"


def decode(p):
    a = np.asarray(Image.open(p).convert("RGBA"), dtype=np.int32)
    return (a[..., 0] << 8) | a[..., 1]


ap = argparse.ArgumentParser()
ap.add_argument("--kind", nargs="+", default=["dsm", "dtm"])
for kind in ap.parse_args().kind:
    s1 = S1 / ("tiles" if kind == "dsm" else "tiles-dtm") / "17"
    n = ident = 0
    worst = []
    allx = []
    for p in sorted((OUT / kind / "17").glob("*/*.png")):
        q = s1 / p.parent.name / p.name
        if not q.exists():
            continue
        a, b = decode(p), decode(q)
        valid = (a > 0) & (b > 0)
        d = np.abs(a - b)
        n += 1
        same = float((d == 0).mean())
        ident += same == 1.0
        worst.append((same, int(d.max()), float(((a > 0) != (b > 0)).mean()), p.parent.name + "/" + p.name))
        allx.append(d[valid])
    if not n:
        print(kind, "no overlapping tiles")
        continue
    allx = np.concatenate(allx)
    worst.sort()
    print(f"{kind}: {n} overlapping tiles, {ident} byte-for-byte identical in value; over all valid pixels: "
          f"{(allx == 0).mean() * 100:.3f}% equal, {(allx <= 1).mean() * 100:.3f}% within 0.25 m, max diff {allx.max() * 0.25:.2f} m")
    for same, mx, nodiff, name in worst[:4]:
        print(f"   least similar {name}: {same * 100:.1f}% equal, max {mx * 0.25:.2f} m, no-data mask differs on {nodiff * 100:.2f}%")
