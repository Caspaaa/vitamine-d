"""Shared helpers for S3: reference terraces, rasters on a 0.25 m grid around each venue, DSM sampling, metrics.

Coordinates: metres relative to the venue point, x east, y north. Raster rows run north -> south.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

HERE = Path(__file__).parent
DATA = HERE / "data"
CROPS = DATA / "crops"
TILES = HERE.parent / "s1-shadow" / "web" / "public"
GRID = 0.25  # m per raster cell
HALF = 20.0  # analysis window half-size, m
N = int(round(2 * HALF / GRID))  # 160


def load_reference(which=None):
    """Reference terraces: the user's reviewed version by default; REF=mine selects my first drawing."""
    import os
    which = which or os.environ.get("REF", "reviewed")
    return json.loads((DATA / ("reference.mine.json" if which == "mine" else "reference.reviewed.json")).read_text())


def load_meta(vid):
    return json.loads((CROPS / f"{vid}.meta.json").read_text())


def load_buildings(vid):
    return json.loads((CROPS / f"{vid}.bld.json").read_text())


def to_rc(x, y):
    return (HALF - y) / GRID, (x + HALF) / GRID  # row, col (fractional, cell edges at integers)


def raster_polys(polys):
    """Boolean N x N mask for a list of polygons in metres."""
    img = Image.new("1", (N, N), 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        pts = [((x + HALF) / GRID, (HALF - y) / GRID) for x, y in poly]
        if len(pts) >= 3:
            d.polygon(pts, fill=1)
    return np.asarray(img, dtype=bool)


def building_masks(vid):
    """(all buildings mask, own building mask). Own = ring containing the venue point, else nearest ring edge."""
    from shapely.geometry import Point, Polygon

    rings = [r for r in load_buildings(vid) if len(r) >= 4]
    polys = []
    for r in rings:
        p = Polygon(r)
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty:
            polys.append(p)
    pt = Point(0, 0)
    own = [p for p in polys if p.contains(pt)]
    if not own and polys:
        near = min(polys, key=lambda p: p.distance(pt))
        if near.distance(pt) < 8:
            own = [near]
    allm = raster_polys([list(p.exterior.coords) for p in polys])
    ownm = raster_polys([list(p.exterior.coords) for p in own]) if own else np.zeros((N, N), bool)
    return allm, ownm, polys, own


class Atlas:
    """DSM/DTM atlas tiles written by s1-shadow/build_tiles.py (z17, uint16 in 0.25 m steps, offset 10 m)."""

    def __init__(self):
        self.meta = json.loads((TILES / "tiles" / "meta.json").read_text())
        self.cache = {}

    def tile(self, kind, tx, ty):
        key = (kind, tx, ty)
        if key not in self.cache:
            root = TILES / ("tiles" if kind == "dsm" else "tiles-dtm") / str(self.meta["zoom"])
            path = root / str(tx) / f"{ty}.png"
            if not path.exists():  # venue close to the atlas edge
                self.cache[key] = np.full((256, 256), np.nan, np.float32)
                return self.cache[key]
            a = np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint32)
            v = (a[..., 0] << 8) | a[..., 1]
            h = v * self.meta["step"] - self.meta["offset"]
            h[v == 0] = np.nan
            self.cache[key] = h.astype(np.float32)
        return self.cache[key]

    def sample(self, kind, lng, lat):
        """Heights on the N x N analysis grid around (lng, lat), bilinear; NaN filled with nearest valid."""
        z = self.meta["zoom"]
        n = 2 ** z * 256
        wx = (lng + 180) / 360 * n
        wy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        mpp = 156543.03392804097 / 2 ** z * math.cos(math.radians(lat))
        r = (HALF + 3) / mpp
        x0, x1 = int((wx - r) // 256), int((wx + r) // 256)
        y0, y1 = int((wy - r) // 256), int((wy + r) // 256)
        mosaic = np.full(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.nan, np.float32)
        for ty in range(y0, y1 + 1):
            for tx in range(x0, x1 + 1):
                mosaic[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = self.tile(
                    kind, tx, ty)
        # fill gaps so bilinear sampling does not leak NaN
        mask = np.isnan(mosaic)
        if mask.any():
            idx = ndi.distance_transform_edt(mask, return_distances=False, return_indices=True)
            mosaic = mosaic[tuple(idx)]
        cols = (np.arange(N) + 0.5) * GRID - HALF
        rows = HALF - (np.arange(N) + 0.5) * GRID
        X, Y = np.meshgrid(cols, rows)
        px = wx + X / mpp - x0 * 256 - 0.5
        py = wy - Y / mpp - y0 * 256 - 0.5
        return ndi.map_coordinates(mosaic, [py, px], order=1, mode="nearest")


def iou(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else float("nan")


def centroid_m(mask):
    rr, cc = np.nonzero(mask)
    if not len(rr):
        return None
    return float((cc.mean() + 0.5) * GRID - HALF), float(HALF - (rr.mean() + 0.5) * GRID)


def sample_points(mask, max_pts=36, stride=4):
    """Sample points (metres) inside a mask on a ~1 m lattice; thinned evenly to at most max_pts."""
    rr, cc = np.nonzero(mask)
    pts = [((c + 0.5) * GRID - HALF, HALF - (r + 0.5) * GRID) for r, c in zip(rr, cc) if r % stride == stride // 2 and c % stride == stride // 2]
    if len(pts) < 3 and len(rr):
        pts = [((c + 0.5) * GRID - HALF, HALF - (r + 0.5) * GRID) for r, c in list(zip(rr, cc))[:: max(1, len(rr) // 6)]]
    if len(pts) > max_pts:
        pts = pts[:: math.ceil(len(pts) / max_pts)]
    return [[round(x, 2), round(y, 2)] for x, y in pts]
