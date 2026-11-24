"""Second batch of reference candidates: 40 more venues tagged with outdoor seating, spread over the atlas and not
already in selected.json. Many tagged venues show no terrace in the photo, so a larger pool is needed to end up with
enough visible terraces for scoring.
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).parent
venues = json.loads((HERE / "data" / "venues.json").read_text())
first = json.loads((HERE / "data" / "selected.json").read_text())
taken = {v["id"] for v in first}

M_LAT = 111_320.0
def xy(v):
    return (v["lng"] * M_LAT * math.cos(math.radians(50.845)), v["lat"] * M_LAT)
def dist(a, b):
    (ax, ay), (bx, by) = xy(a), xy(b)
    return math.hypot(ax - bx, ay - by)

pool = [v for v in venues if v["seating"] in ("yes", "sidewalk", "pedestrian_zone") and v["id"] not in taken
        and v["amenity"] in ("restaurant", "cafe", "bar", "pub")]
quota = {"restaurant": 18, "cafe": 12, "bar": 6, "pub": 4}
chosen = []
while sum(quota.values()) > 0:
    cands = [v for v in pool if v not in chosen and quota[v["amenity"]] > 0]
    ref = first + chosen
    best = max(cands, key=lambda v: min(dist(v, c) for c in ref))
    chosen.append(best)
    quota[best["amenity"]] -= 1
for v in chosen:
    v["expect"] = "terrace"
(HERE / "data" / "selected2.json").write_text(json.dumps(chosen, indent=1, ensure_ascii=False))
for i, v in enumerate(chosen, 1):
    print(f"{i:2d} {v['id']:>12s} {v['amenity']:10s} {v['seating']:10s} {v['name'][:30]}")
