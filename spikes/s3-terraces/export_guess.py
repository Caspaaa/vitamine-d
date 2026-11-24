"""Writes what the automatic methods propose, for the review page.

  data/guess_A.json         {venue_id: [polygon, ...]}   heuristic rectangle (metres east/north of the venue point)
  data/guess/<id>.B.png     40 m x 40 m RGBA overlay (0.25 m / px) of the classifier mask (CV prediction, no look at the label)
"""
import json

import numpy as np
from PIL import Image

from baseline_a import baseline_a
from method_b import postprocess
from terrace_lib import DATA, load_reference

(DATA / "guess").mkdir(exist_ok=True)
cfg = json.load(open(DATA / "pred_b_cfg.json"))
probs = np.load(DATA / "pred_b_prob.npz")
ref = load_reference()
guess_a = {}
nb = 0
for vid in ref:
    try:
        guess_a[vid] = [[[round(x, 2), round(y, 2)] for x, y in poly] for poly in baseline_a(vid)]
    except Exception as e:  # venues without footprints
        print(vid, "no A guess:", e)
    if vid in probs.files:
        m = postprocess(probs[vid], cfg["threshold"])
        rgba = np.zeros(m.shape + (4,), np.uint8)
        rgba[m] = (0, 220, 255, 255)
        Image.fromarray(rgba).save(DATA / "guess" / f"{vid}.B.png")
        nb += 1
json.dump(guess_a, open(DATA / "guess_A.json", "w"))
lst = []
for f in ("selected.json", "selected2.json"):
    lst += [{k: v[k] for k in ("id", "name", "amenity", "seating", "lat", "lng", "osm")} for v in json.load(open(DATA / f)) if v["id"] in ref]
json.dump(lst, open(DATA / "review_list.json", "w"), ensure_ascii=False)
print(f"A guesses: {len(guess_a)}, B overlays: {nb}, venues: {len(lst)}")
