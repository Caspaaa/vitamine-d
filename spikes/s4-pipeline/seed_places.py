"""Seed terraces for every Brussels venue (spike S4, pipeline step 3).

  venues (Overpass, data/venues-brussels-raw.json)
    + UrbIS building footprints (WFS, one request per 1 km cell that contains venues, cached in data/bld/)
    -> method A from spike S3: a 12 m x 6 m rectangle on the free side of the facade nearest the OSM point
    -> data/terraces-seed.json: polygon + 3x3 sample points (lng/lat) per venue, ready for the horizon job.

  python seed_places.py [--fetch-venues]
"""
import json
import math
import sys
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon

HERE = Path(__file__).parent
DATA = HERE / "data"
BLD = DATA / "bld"
UA = {"User-Agent": "vitamine-d-pipeline/0.1 (personal open-data project)"}
WFS = ("https://geoservices-vector.irisnet.be/geoserver/urbisvector/wfs?service=WFS&version=2.0.0&request=GetFeature"
       "&typeNames=urbisvector:Buildings&outputFormat=application/json&srsName=EPSG:31370&bbox={x0},{y0},{x1},{y1},EPSG:31370")
LENGTH, DEPTH, OFFSET = 12.0, 6.0, 0.3
to_l72 = Transformer.from_crs(4326, 31370, always_xy=True)
to_wgs = Transformer.from_crs(31370, 4326, always_xy=True)
OVERPASS_Q = """[out:json][timeout:180];
area["ISO3166-2"="BE-BRU"]->.a;
nwr["amenity"~"^(restaurant|cafe|bar|pub|biergarten)$"](area.a);
out center tags;"""


def fetch_venues():
    for attempt in range(5):
        try:
            req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                         data=urllib.parse.urlencode({"data": OVERPASS_Q}).encode(), headers=UA)
            raw = urllib.request.urlopen(req, timeout=200).read()
            (DATA / "venues-brussels-raw.json").write_bytes(raw)
            return json.loads(raw)
        except Exception as e:
            print("overpass retry", attempt, e)
            time.sleep(5 * (attempt + 1))
    raise SystemExit("Overpass unavailable")


def fetch_cell(cell):
    out = BLD / f"{cell[0]}_{cell[1]}.json"
    if out.exists():
        return cell, 0
    x0, y0 = cell[0] * 1000 - 30, cell[1] * 1000 - 30
    url = WFS.format(x0=x0, y0=y0, x1=x0 + 1060, y1=y0 + 1060)
    for attempt in range(4):
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
            gj = json.loads(raw)
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    rings = []
    for f in gj["features"]:
        g = f["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            rings.append([[round(x, 2), round(y, 2)] for x, y in poly[0]])  # exterior ring only
    out.write_text(json.dumps(rings, separators=(",", ":")))
    return cell, len(raw)


def facade_rect(vx, vy, polys, tree):
    """Method A. Returns (polygon corners, fallback flag), in Lambert metres."""
    pt = Point(vx, vy)
    near = [polys[i] for i in tree.query(pt.buffer(12))]
    own = [p for p in near if p.contains(pt)]
    if not own and near:
        n = min(near, key=lambda p: p.distance(pt))
        if n.distance(pt) < 8:
            own = [n]
    cands = own or [p for p in near if p.distance(pt) < 10]

    def free(x, y):
        q = Point(x, y)
        return not any(polys[i].contains(q) for i in tree.query(q))

    best = None
    for p in cands:
        c = list(p.exterior.coords)
        for (x1, y1), (x2, y2) in zip(c[:-1], c[1:]):
            el = math.hypot(x2 - x1, y2 - y1)
            if el < 3:
                continue
            ux, uy = (x2 - x1) / el, (y2 - y1) / el
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            for nx, ny in ((uy, -ux), (-uy, ux)):
                if free(mx + nx * 1.5, my + ny * 1.5) and free(mx + nx * 3.0, my + ny * 3.0):
                    d = LineString([(x1, y1), (x2, y2)]).distance(pt)
                    if best is None or d < best[0]:
                        best = (d, (x1, y1), (ux, uy), (nx, ny))
    if best is None or best[0] > 12:
        h = 2.0
        return [(vx - h, vy - h), (vx + h, vy - h), (vx + h, vy + h), (vx - h, vy + h)], True
    _, (x1, y1), (ux, uy), (nx, ny) = best
    t = (vx - x1) * ux + (vy - y1) * uy
    a, b = t - LENGTH / 2, t + LENGTH / 2
    p0 = (x1 + ux * a + nx * OFFSET, y1 + uy * a + ny * OFFSET)
    p1 = (x1 + ux * b + nx * OFFSET, y1 + uy * b + ny * OFFSET)
    return [p0, p1, (p1[0] + nx * DEPTH, p1[1] + ny * DEPTH), (p0[0] + nx * DEPTH, p0[1] + ny * DEPTH)], False


def sample_grid(corners):
    """3 x 3 points at the centres of a 3 x 3 grid over the rectangle (the odd grid chosen in S2)."""
    (x0, y0), (x1, y1), _, (x3, y3) = corners
    return [(x0 + (x1 - x0) * (i + 0.5) / 3 + (x3 - x0) * (j + 0.5) / 3,
             y0 + (y1 - y0) * (i + 0.5) / 3 + (y3 - y0) * (j + 0.5) / 3) for i in range(3) for j in range(3)]


def main():
    t_all = time.time()
    DATA.mkdir(exist_ok=True)
    BLD.mkdir(exist_ok=True)
    raw = fetch_venues() if "--fetch-venues" in sys.argv else json.loads((DATA / "venues-brussels-raw.json").read_text())
    venues = []
    for e in raw["elements"]:
        t = e.get("tags", {})
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lng = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None or not t.get("name"):
            continue
        x, y = to_l72.transform(lng, lat)
        venues.append({"id": f"{e['type'][0]}{e['id']}", "name": t["name"], "type": t["amenity"], "seating": t.get("outdoor_seating", ""),
                       "lat": lat, "lng": lng, "x": x, "y": y})
    cells = sorted({(int(v["x"] // 1000), int(v["y"] // 1000)) for v in venues})
    # A venue near a cell edge may need the neighbour's buildings; the 30 m margin on each request covers that.
    t0 = time.time()
    with ThreadPoolExecutor(4) as pool:
        nbytes = sum(n for _, n in pool.map(fetch_cell, cells))
    print(f"{len(venues)} venues in {len(cells)} 1 km cells; WFS {nbytes / 1e6:.0f} MB downloaded in {time.time() - t0:.0f}s")

    t0 = time.time()
    out, fallback = [], 0
    for cell in cells:
        rings = json.loads((BLD / f"{cell[0]}_{cell[1]}.json").read_text())
        polys = [p for p in (Polygon(r) for r in rings if len(r) >= 4) if not p.is_empty]
        polys = [p if p.is_valid else p.buffer(0) for p in polys]
        tree = STRtree(polys)
        for v in venues:
            if (int(v["x"] // 1000), int(v["y"] // 1000)) != cell:
                continue
            corners, fb = facade_rect(v["x"], v["y"], polys, tree)
            fallback += fb
            ll = lambda xy: [round(c, 7) for c in to_wgs.transform(*xy)]
            out.append({"id": v["id"], "name": v["name"], "type": v["type"], "seating": v["seating"], "lat": v["lat"], "lng": v["lng"],
                        "status": "seeded", "fallback": fb, "polygon": [ll(c) for c in corners],
                        "points": [ll(p) for p in sample_grid(corners)]})
    (DATA / "terraces-seed.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"seeded {len(out)} terraces in {time.time() - t0:.1f}s ({fallback} used the 4 m fallback square: no footprint within 12 m); total {time.time() - t_all:.0f}s")


if __name__ == "__main__":
    main()
