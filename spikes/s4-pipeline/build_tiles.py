"""Step 2 of the height-tile pipeline: z17 web-mercator height tiles from the cached UrbIS rasters.

No mosaic: every output tile reads only the source windows it needs (1-4 source files), so memory stays flat and the same
code builds 1 km^2 or all of Brussels. Encoding is identical to the S1 prototype:
    value = round((elevation_m + 10) / 0.25) as uint16   R = high byte, G = low byte, B = 0 (reserved), A = 255
    value 0 = no data.  Tiles with no data at all are not written; index.json lists the tiles that exist.

  python build_tiles.py --kind dsm dtm                 # everything in data/raw
  python build_tiles.py --kind dsm --codes 148170       # only tiles that touch these 1 km source tiles
"""
import argparse
import json
import math
import os
import resource
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window

HERE = Path(__file__).parent
RAW = Path(os.environ.get("RAW_DIR", HERE / "data" / "raw"))
OUT = Path(os.environ.get("OUT_DIR", HERE / "out"))
ZOOM, TILE_PX, OFFSET, STEP = 17, 256, 10.0, 0.25
ORIGIN_SHIFT = 20037508.342789244
SRC_PX = 2000  # pixels per source tile side
MARGIN_M = 4.0  # source margin around each output tile for bilinear support

_meta = {}  # worker globals
_open = {}


def tile_bounds_3857(x, y):
    size = 2 * ORIGIN_SHIFT / (2 ** ZOOM)
    xmin = -ORIGIN_SHIFT + x * size
    ymax = ORIGIN_SHIFT - y * size
    return xmin, ymax - size, xmin + size, ymax


def scan(kind):
    """Shared global pixel grid: its origin and every cached source tile as (code, col, row, width, height).

    Tiles at the regional boundary are clipped (as small as 15 px wide) but all sit on the same 0.5 m grid."""
    infos = []
    for p in sorted((RAW / kind).glob("*.tif")):
        with rasterio.open(p) as s:
            assert abs(s.transform.a - 0.5) < 1e-9 and abs(s.transform.e + 0.5) < 1e-9, p
            infos.append((p.stem, s.transform.c, s.transform.f, s.width, s.height))
    x0 = min(i[1] for i in infos)
    y0 = max(i[2] for i in infos)
    tiles = []
    for code, ox, oy, w, h in infos:
        col, row = (ox - x0) / 0.5, (y0 - oy) / 0.5
        assert abs(col - round(col)) < 1e-3 and abs(row - round(row)) < 1e-3, f"{code} is not on the shared 0.5 m grid"
        tiles.append((code, round(col), round(row), w, h))
    return x0, y0, tiles


def init_worker(kind, x0, y0, tiles):
    _meta.update(kind=kind, x0=x0, y0=y0, tiles=tiles, to_l72=Transformer.from_crs(3857, 31370, always_xy=True))


def _dataset(code):
    if code not in _open:
        if len(_open) >= 12:
            _open.pop(next(iter(_open))).close()
        _open[code] = rasterio.open(RAW / _meta["kind"] / f"{code}.tif")
    return _open[code]


def window(col0, row0, w, h):
    """float32 array (h, w) from the shared global pixel grid; NaN where there is no source tile."""
    out = np.full((h, w), np.nan, np.float32)
    for code, tc, tr, tw, th in _meta["tiles"]:
        c0, r0 = max(col0, tc), max(row0, tr)
        c1, r1 = min(col0 + w, tc + tw), min(row0 + h, tr + th)
        if c1 <= c0 or r1 <= r0:
            continue
        data = _dataset(code).read(1, window=Window(c0 - tc, r0 - tr, c1 - c0, r1 - r0))
        out[r0 - row0:r1 - row0, c0 - col0:c1 - col0] = data
    return out


def encode(elev):
    v = np.rint((elev + OFFSET) / STEP)
    v = np.clip(v, 0, 65535).astype(np.uint16)
    rgba = np.zeros(elev.shape + (4,), np.uint8)
    rgba[..., 0] = v >> 8
    rgba[..., 1] = v & 255
    rgba[..., 3] = 255
    return rgba


def build_one(job):
    tx, ty = job
    t0 = time.time()
    xmin, ymin, xmax, ymax = tile_bounds_3857(tx, ty)
    xs = np.linspace(xmin, xmax, 9)
    ys = np.linspace(ymin, ymax, 9)
    px, py = np.meshgrid(xs, ys)
    lx, ly = _meta["to_l72"].transform(px.ravel(), py.ravel())
    left, right, bottom, top = min(lx) - MARGIN_M, max(lx) + MARGIN_M, min(ly) - MARGIN_M, max(ly) + MARGIN_M
    col0, row0 = math.floor((left - _meta["x0"]) / 0.5), math.floor((_meta["y0"] - top) / 0.5)
    w, h = math.ceil((right - left) / 0.5) + 1, math.ceil((top - bottom) / 0.5) + 1
    src = window(col0, row0, w, h)
    if not np.isfinite(src).any():
        return tx, ty, 0, time.time() - t0
    res = (xmax - xmin) / TILE_PX
    dst = np.full((TILE_PX, TILE_PX), np.nan, np.float32)
    reproject(source=src, destination=dst,
              src_transform=Affine(0.5, 0, _meta["x0"] + col0 * 0.5, 0, -0.5, _meta["y0"] - row0 * 0.5),
              src_crs=CRS.from_epsg(31370), dst_transform=Affine(res, 0, xmin, 0, -res, ymax), dst_crs=CRS.from_epsg(3857),
              src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    dst = np.nan_to_num(dst, nan=-OFFSET)
    rgba = encode(dst)
    if not (rgba[..., 0].any() or rgba[..., 1].any()):
        return tx, ty, 0, time.time() - t0
    path = OUT / _meta["kind"] / str(ZOOM) / str(tx) / f"{ty}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)
    return tx, ty, path.stat().st_size, time.time() - t0


def candidates(x0, y0, tiles, only_codes):
    """z17 tiles that overlap the cached source tiles (or only the given ones)."""
    to_merc = Transformer.from_crs(31370, 3857, always_xy=True)
    size = 2 * ORIGIN_SHIFT / (2 ** ZOOM)
    out = set()
    for code, col, row, w, h in tiles:
        if only_codes and code not in only_codes:
            continue
        xs = np.linspace(x0 + col * 0.5, x0 + (col + w) * 0.5, 11)
        ys = np.linspace(y0 - (row + h) * 0.5, y0 - row * 0.5, 11)
        px, py = np.meshgrid(xs, ys)
        mx, my = to_merc.transform(px.ravel(), py.ravel())
        tx0, tx1 = int((min(mx) + ORIGIN_SHIFT) // size), int((max(mx) + ORIGIN_SHIFT) // size)
        ty0, ty1 = int((ORIGIN_SHIFT - max(my)) // size), int((ORIGIN_SHIFT - min(my)) // size)
        out.update((x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1))
    return sorted(out)


def write_index(kind, done, source):
    """Existing tiles as x-runs per row, so the client never asks for a tile that is not there."""
    rows = {}
    for tx, ty, nbytes, _ in done:
        if nbytes:
            rows.setdefault(ty, []).append(tx)
    runs = {}
    for ty, xs in sorted(rows.items()):
        xs.sort()
        r = [[xs[0], xs[0]]]
        for x in xs[1:]:
            if x == r[-1][1] + 1:
                r[-1][1] = x
            else:
                r.append([x, x])
        runs[str(ty)] = r
    index = {"kind": kind, "zoom": ZOOM, "tileSize": TILE_PX, "offset": OFFSET, "step": STEP, "source": source,
             "count": sum(1 for d in done if d[2]), "rows": runs}
    (OUT / kind).mkdir(parents=True, exist_ok=True)
    (OUT / kind / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    return index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", nargs="+", default=["dsm", "dtm"], choices=["dsm", "dtm"])
    ap.add_argument("--codes", nargs="*", default=None, help="only tiles touching these 1 km source tiles")
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    for kind in a.kind:
        t0 = time.time()
        x0, y0, tiles = scan(kind)
        jobs = candidates(x0, y0, tiles, set(a.codes or []))
        with Pool(a.procs, initializer=init_worker, initargs=(kind, x0, y0, tiles)) as pool:
            done = list(pool.imap_unordered(build_one, jobs, chunksize=8))
        wall = time.time() - t0
        sizes = np.array([d[2] for d in done if d[2]])
        secs = np.array([d[3] for d in done])
        src = "UrbIS " + kind.upper() + " 2021 (Paradigm / Brussels Region, CC0)"
        idx = write_index(kind, done, src)
        print(f"{kind}: {len(jobs)} candidate tiles, {idx['count']} written, {len(jobs) - idx['count']} empty | wall {wall:.1f}s with {a.procs} procs, "
              f"{secs.mean() * 1000:.0f} ms/tile (CPU) | PNG median {np.median(sizes) / 1024:.1f} KB, mean {sizes.mean() / 1024:.1f} KB, "
              f"max {sizes.max() / 1024:.1f} KB, total {sizes.sum() / 1e6:.1f} MB | peak RSS workers "
              f"{resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
