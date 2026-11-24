"""Pick the venues used as the S3 reference set: spread out in space, mixed in type.

30 venues tagged with outdoor seating (yes / sidewalk / pedestrian_zone) chosen by farthest-point sampling with
per-type quotas, plus 4 tagged outdoor_seating=no as negatives (does the method wrongly invent a terrace?).
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).parent
raw = json.loads((HERE / "data" / "venues-raw.json").read_text())

venues = []
for e in raw["elements"]:
    t = e.get("tags", {})
    if not t.get("name"):
        continue
    lat = e.get("lat") or e.get("center", {}).get("lat")
    lon = e.get("lon") or e.get("center", {}).get("lon")
    if lat is None:
        continue
    venues.append({
        "id": f"{e['type'][0]}{e['id']}", "osm": f"{e['type']}/{e['id']}", "name": t["name"], "amenity": t["amenity"],
        "seating": t.get("outdoor_seating", ""), "lat": lat, "lng": lon, "is_building": e["type"] != "node",
    })

M_LAT = 111_320.0
def xy(v):  # metres, equirectangular around Brussels
    return (v["lng"] * M_LAT * math.cos(math.radians(50.845)), v["lat"] * M_LAT)

def dist(a, b):
    (ax, ay), (bx, by) = xy(a), xy(b)
    return math.hypot(ax - bx, ay - by)

pos = [v for v in venues if v["seating"] in ("yes", "sidewalk", "pedestrian_zone")]
neg = [v for v in venues if v["seating"] == "no"]
print(f"{len(venues)} named venues; {len(pos)} with outdoor seating, {len(neg)} tagged no")

def spread(pool, quota, already):
    """Farthest-point sampling inside `pool`, respecting per-type quotas."""
    picked = []
    quota = dict(quota)
    while sum(quota.values()) > 0:
        cands = [v for v in pool if v not in already + picked and quota.get(v["amenity"], 0) > 0]
        if not cands:
            break
        ref = already + picked
        best = max(cands, key=lambda v: min(dist(v, c) for c in ref)) if ref else cands[0]
        picked.append(best)
        quota[best["amenity"]] -= 1
    return picked

grand_place = {"lat": 50.8467, "lng": 4.3525}
central = [v for v in pos if dist(v, grand_place) < 900]
outer = [v for v in pos if dist(v, grand_place) >= 900]
print(f"{len(central)} central candidates, {len(outer)} outer candidates")
chosen = spread(central, {"restaurant": 5, "cafe": 3, "bar": 3, "pub": 3}, [])
chosen += spread(outer, {"restaurant": 7, "cafe": 6, "bar": 2, "pub": 1}, chosen)

negatives = []
for amen, n in (("restaurant", 2), ("cafe", 1), ("bar", 1)):
    cands = [v for v in neg if v["amenity"] == amen and v not in negatives]
    for _ in range(n):
        if not cands:
            break
        pick = max(cands, key=lambda v: min(dist(v, c) for c in chosen + negatives))
        negatives.append(pick)
        cands.remove(pick)

for v in chosen:
    v["expect"] = "terrace"
for v in negatives:
    v["expect"] = "none"
out = chosen + negatives
(HERE / "data" / "selected.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
(HERE / "data" / "venues.json").write_text(json.dumps(venues, ensure_ascii=False))
for i, v in enumerate(out, 1):
    print(f"{i:2d} {v['id']:>12s} {v['amenity']:10s} {v['seating']:16s} {'bldg' if v['is_building'] else 'node'} {v['name'][:34]:34s} {v['lat']:.5f},{v['lng']:.5f}")
