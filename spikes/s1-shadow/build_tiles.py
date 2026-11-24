"""Build z17 web-mercator height tiles from the UrbIS DSM (EPSG:31370, 0.5 m).

Encoding (RGBA PNG, A always 255):
    value = round((elevation_m + OFFSET) / STEP)   -> uint16
    R = value >> 8, G = value & 255, B = 0 (reserved for the surface class)

Usage: python build_tiles.py [--step 0.25] [--zoom 17] [--tiles 16]
"""
import argparse
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject

HERE = Path(__file__).parent
RAW = HERE / "data" / "raw" / "dsm"
OUT = HERE / "web" / "public" / "tiles"  # --kind dtm writes to tiles-dtm
OFFSET = 10.0  # metres added before quantisation so values stay positive
TILE_PX = 256
ORIGIN_SHIFT = 20037508.342789244


def load_mosaic(kind="dsm", cx=147, cy=169, size=3):
    """Stitch the size x size block of 1 km tiles whose lower-left tile is (cx, cy)."""
    raw = HERE / "data" / "raw" / kind
    px = 2000
    mosaic = np.full((size * px, size * px), np.nan, dtype=np.float32)
    transform = None
    for dx in range(size):
        for dy in range(size):
            path = raw / f"{cx + dx}{cy + dy}.tif"
            if not path.exists():
                continue
            with rasterio.open(path) as src:
                row, col = (size - 1 - dy) * px, dx * px
                mosaic[row:row + px, col:col + px] = src.read(1)
                if dx == 0 and dy == size - 1:
                    transform = src.transform
    return mosaic, transform


def tile_bounds(z, x, y):
    size = 2 * ORIGIN_SHIFT / (2 ** z)
    xmin = -ORIGIN_SHIFT + x * size
    ymax = ORIGIN_SHIFT - y * size
    return xmin, ymax - size, xmin + size, ymax


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def encode(elev, step):
    v = np.rint((elev + OFFSET) / step)
    v = np.clip(v, 0, 65535).astype(np.uint16)
    rgba = np.zeros(elev.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = v >> 8
    rgba[..., 1] = v & 255
    rgba[..., 3] = 255
    return rgba


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=float, default=0.25, help="elevation quantisation in metres")
    ap.add_argument("--zoom", type=int, default=17)
    ap.add_argument("--tiles", type=int, default=16, help="atlas size in tiles (square)")
    ap.add_argument("--resampling", default="bilinear")
    ap.add_argument("--kind", default="dsm", choices=["dsm", "dtm"], help="dsm = surface (buildings, trees), dtm = bare ground")
    args = ap.parse_args()

    out_root = OUT if args.kind == "dsm" else OUT.parent / "tiles-dtm"
    mosaic, src_transform = load_mosaic(args.kind)
    src_crs = CRS.from_epsg(31370)
    h, w = mosaic.shape
    # Atlas centred on the mosaic centre.
    to_ll = Transformer.from_crs(31370, 4326, always_xy=True)
    cx_m, cy_m = src_transform * (w / 2, h / 2)
    lon, lat = to_ll.transform(cx_m, cy_m)
    tx, ty = lonlat_to_tile(lon, lat, args.zoom)
    x0, y0 = tx - args.tiles // 2, ty - args.tiles // 2
    print(f"centre lon/lat {lon:.5f},{lat:.5f} -> tile {tx},{ty}; atlas tiles x {x0}..{x0 + args.tiles - 1}, y {y0}..{y0 + args.tiles - 1}")

    resampling = getattr(Resampling, args.resampling)
    total = 0
    sizes = []
    for ty_ in range(y0, y0 + args.tiles):
        for tx_ in range(x0, x0 + args.tiles):
            xmin, ymin, xmax, ymax = tile_bounds(args.zoom, tx_, ty_)
            res = (xmax - xmin) / TILE_PX
            dst_transform = Affine(res, 0, xmin, 0, -res, ymax)
            dst = np.full((TILE_PX, TILE_PX), np.nan, dtype=np.float32)
            reproject(
                source=mosaic, destination=dst,
                src_transform=src_transform, src_crs=src_crs,
                dst_transform=dst_transform, dst_crs=CRS.from_epsg(3857),
                src_nodata=np.nan, dst_nodata=np.nan, resampling=resampling,
            )
            dst = np.nan_to_num(dst, nan=-OFFSET + 0.0)  # outside coverage: lowest value, casts nothing
            out = out_root / str(args.zoom) / str(tx_) / f"{ty_}.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(encode(dst, args.step), "RGBA").save(out, optimize=True)
            sizes.append(out.stat().st_size)
            total += 1
    sizes = np.array(sizes)
    print(f"{total} tiles, step {args.step} m; PNG size median {np.median(sizes) / 1024:.0f} KB, "
          f"mean {sizes.mean() / 1024:.0f} KB, max {sizes.max() / 1024:.0f} KB, total {sizes.sum() / 1e6:.1f} MB")
    (out_root / "meta.json").write_text(
        '{"zoom": %d, "x0": %d, "y0": %d, "tiles": %d, "offset": %s, "step": %s}\n'
        % (args.zoom, x0, y0, args.tiles, OFFSET, args.step)
    )


if __name__ == "__main__":
    main()
