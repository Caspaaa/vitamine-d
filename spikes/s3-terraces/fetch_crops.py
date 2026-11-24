"""Fetch a 60 m x 60 m crop of the UrbIS 2024 orthophoto (z21, ~4.7 cm/px) and the building footprints around each
selected venue, and render a gridded copy to draw on.

Outputs per venue id (data/crops/):
  <id>.jpg        raw crop, 1280 x 1280 px, north up, venue at the centre (640, 640)
  <id>.meta.json  centre, metres per pixel, world pixel origin
  <id>.bld.json   building footprints as [east_m, north_m] rings relative to the venue point
  <id>.grid.jpg   crop with a 5 m grid, labelled axes, building outlines (cyan) and the venue point (red)
"""
import io
import json
import math
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer

HERE = Path(__file__).parent
OUT = HERE / "data" / "crops"
OUT.mkdir(parents=True, exist_ok=True)
Z = 21
TILE = 256
HALF = 640  # px; 1280 px = 60 m
ORTHO = ("https://geoservices-grid.irisnet.be/geowebcache/service/wmts?layer=Ortho&style=&tilematrixset=EPSG:900913"
         "&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix=EPSG:900913:{z}&TileCol={x}&TileRow={y}")
WFS = ("https://geoservices-vector.irisnet.be/geoserver/urbisvector/wfs?service=WFS&version=2.0.0&request=GetFeature"
       "&typeNames=urbisvector:Buildings&outputFormat=application/json&srsName=EPSG:31370&bbox={x0},{y0},{x1},{y1},EPSG:31370")
to_lambert = Transformer.from_crs(4326, 31370, always_xy=True)
UA = {"User-Agent": "vitamine-d-spike/0.1 (personal project)"}


def world_px(lng, lat):
    n = 2 ** Z * TILE
    return (lng + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def fetch(url, tries=4):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()
        except Exception:
            if i == tries - 1:
                raise
    return b""


def get_tile(args):
    x, y = args
    return (x, y), Image.open(io.BytesIO(fetch(ORTHO.format(z=Z, x=x, y=y)))).convert("RGB")


def font(size):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def process(v):
    vid = v["id"]
    if (OUT / f"{vid}.grid.jpg").exists():
        return f"{vid}: cached"
    lat, lng = v["lat"], v["lng"]
    wx, wy = world_px(lng, lat)
    mpp = 156543.03392804097 / 2 ** Z * math.cos(math.radians(lat))
    x0, x1 = math.floor((wx - HALF) / TILE), math.floor((wx + HALF) / TILE)
    y0, y1 = math.floor((wy - HALF) / TILE), math.floor((wy + HALF) / TILE)
    mosaic = Image.new("RGB", ((x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE))
    for (tx, ty), img in map(get_tile, [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]):
        mosaic.paste(img, ((tx - x0) * TILE, (ty - y0) * TILE))
    left, top = round(wx - HALF - x0 * TILE), round(wy - HALF - y0 * TILE)
    crop = mosaic.crop((left, top, left + 2 * HALF, top + 2 * HALF))
    crop.save(OUT / f"{vid}.jpg", quality=93)

    # Buildings (Lambert-72 metres) -> [east, north] relative to the venue point.
    cx, cy = to_lambert.transform(lng, lat)
    r = HALF * mpp + 15
    rings = []
    try:
        gj = json.loads(fetch(WFS.format(x0=cx - r, y0=cy - r, x1=cx + r, y1=cy + r)))
        for f in gj.get("features", []):
            g = f["geometry"]
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
            for poly in polys:
                for ring in poly:
                    rings.append([[round(x - cx, 2), round(y - cy, 2)] for x, y in ring])
    except Exception as e:  # footprints are a nicety for drawing, not required
        print(f"{vid}: no building footprints ({e})")
    (OUT / f"{vid}.bld.json").write_text(json.dumps(rings))
    meta = {"id": vid, "name": v["name"], "lat": lat, "lng": lng, "mpp": mpp, "size": 2 * HALF, "zoom": Z,
            "lambert": [cx, cy], "osm": v["osm"], "amenity": v["amenity"], "seating": v["seating"], "expect": v["expect"]}
    (OUT / f"{vid}.meta.json").write_text(json.dumps(meta))

    # Gridded copy to draw on. Metres relative to the venue point: x east, y north.
    g = crop.copy().convert("RGBA")
    over = Image.new("RGBA", g.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    f12, f16 = font(18), font(22)
    c = HALF
    px = lambda m: c + m / mpp
    for m in range(-30, 31, 5):
        major = m % 10 == 0
        col = (255, 255, 255, 120 if major else 55)
        d.line([(px(m), 0), (px(m), 2 * HALF)], fill=col, width=2 if major else 1)
        d.line([(0, c - m / mpp), (2 * HALF, c - m / mpp)], fill=col, width=2 if major else 1)
    for ring in rings:
        pts = [(c + x / mpp, c - y / mpp) for x, y in ring]
        d.line(pts + pts[:1], fill=(0, 230, 255, 230), width=2)
    d.line([(c - 16, c), (c + 16, c)], fill=(255, 40, 40, 255), width=3)
    d.line([(c, c - 16), (c, c + 16)], fill=(255, 40, 40, 255), width=3)
    d.ellipse([c - 9, c - 9, c + 9, c + 9], outline=(255, 40, 40, 255), width=3)
    g = Image.alpha_composite(g, over)
    d = ImageDraw.Draw(g)
    for m in range(-30, 31, 10):
        for (x, y, t) in ((px(m) + 3, 4, f"{m:+d}" if m else "0"), (4, c - m / mpp + 2, f"{m:+d}" if m else "0")):
            d.text((x, y), t, fill=(255, 255, 0, 255), font=f12, stroke_width=3, stroke_fill=(0, 0, 0, 255))
    d.text((8, 2 * HALF - 30), f"{vid}  {v['name']}  [{v['amenity']}, outdoor_seating={v['seating'] or '-'}]   grid 5 m, labels = metres from the venue point (x east, y north)",
           fill=(255, 255, 255, 255), font=f12, stroke_width=3, stroke_fill=(0, 0, 0, 255))
    g.convert("RGB").save(OUT / f"{vid}.grid.jpg", quality=90)
    return f"{vid}: ok ({len(rings)} building rings)"


if __name__ == "__main__":
    import sys
    venues = json.loads((HERE / "data" / (sys.argv[1] if len(sys.argv) > 1 else "selected.json")).read_text())
    with ThreadPoolExecutor(4) as pool:
        for line in pool.map(process, venues):
            print(line)
