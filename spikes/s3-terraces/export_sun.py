"""Exports, per reference terrace, sample points for: ref (my polygon), A (heuristic), B (classifier, CV predictions), P (OSM point).

  python export_sun.py  ->  data/sun_input.json, consumed by sun_score.ts
"""
import json

import numpy as np

from baseline_a import baseline_a
from method_b import postprocess
from terrace_lib import DATA, load_meta, load_reference, raster_polys, sample_points


def main():
    ref = load_reference()
    mine = load_reference("mine")
    cfg = json.load(open(DATA / "pred_b_cfg.json"))
    probs = np.load(DATA / "pred_b_prob.npz")
    out, masks = {}, {}
    for vid, r in ref.items():
        if r["status"] != "terrace" or not r["polys"]:
            continue
        meta = load_meta(vid)
        gt = raster_polys(r["polys"])
        a = raster_polys(baseline_a(vid))
        b = postprocess(probs[vid], cfg["threshold"])
        sets = {"ref": sample_points(gt), "A": sample_points(a), "B": sample_points(b) if b.any() else [], "P": [[0.0, 0.0]]}
        from scipy import ndimage as ndi
        grow = lambda m, metres: ndi.binary_dilation(m, iterations=int(metres / 0.25))
        sets["Aw"] = sample_points(grow(a, 2.0), max_pts=49)  # uncertainty-aware: A rectangle grown by 2 m
        sets["Bw"] = sample_points(grow(b, 1.0), max_pts=49) if b.any() else []
        if mine.get(vid, {}).get("status") == "terrace" and mine[vid]["polys"]:
            sets["H"] = sample_points(raster_polys(mine[vid]["polys"]))  # my independent drawing: human-vs-human ceiling
        for d in (1, 2, 3, 5):  # sensitivity: reference polygon moved by d metres
            for name, (dx, dy) in {"E": (1, 0), "N": (0, 1), "W": (-1, 0), "S": (0, -1)}.items():
                sets[f"shift{d}_{name}"] = [[round(x + d * dx, 2), round(y + d * dy, 2)] for x, y in sets["ref"]]
        out[vid] = {"name": meta["name"], "lng": meta["lng"], "lat": meta["lat"], "sets": sets}
        masks[vid] = {"ref": gt, "A": a, "B": b}
    json.dump(out, open(DATA / "sun_input.json", "w"))
    np.savez_compressed(DATA / "masks.npz", **{f"{v}_{k}": m for v, d in masks.items() for k, m in d.items()})
    print(len(out), "venues exported;", sum(len(v["sets"]["ref"]) for v in out.values()), "reference points")


if __name__ == "__main__":
    main()
