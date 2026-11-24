"""Figure for the S3 write-up: reviewed reference (green) vs heuristic A (yellow) vs classifier B (cyan, cross-validated).

  python figure.py  ->  ../../docs/spikes/s3-assets/compare.jpg
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

from terrace_lib import CROPS, DATA, GRID, HALF, N, centroid_m, iou, load_meta

OUT = DATA.parent.parent.parent / "docs" / "spikes" / "s3-assets"
OUT.mkdir(parents=True, exist_ok=True)
masks = np.load(DATA / "masks.npz")
pos = sorted({k.rsplit("_", 1)[0] for k in masks.files})
rows = []
for v in pos:
    g, a, b = masks[f"{v}_ref"], masks[f"{v}_A"], masks[f"{v}_B"]
    rows.append((v, iou(g, a) if a.any() else 0.0, iou(g, b) if b.any() else 0.0))
by_both = sorted(rows, key=lambda r: -min(r[1], r[2]))
worst = sorted(rows, key=lambda r: max(r[1], r[2]))
mid = sorted(rows, key=lambda r: (r[1] + r[2]) / 2)[len(rows) // 2 - 1: len(rows) // 2 + 1]
chosen = by_both[:2] + mid + worst[:2]
SIZE, VIEW = 520, 14.0
S = SIZE / (2 * VIEW)  # screen px per metre
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
sheet = Image.new("RGB", (SIZE * 3, SIZE * 2))


def edge_layer(mask, cx, cy):
    """Boolean tile-resolution outline of a metre-grid mask (tile centred on cx, cy)."""
    px = (np.arange(SIZE) + 0.5) / S + (cx - VIEW)
    py = (cy + VIEW) - (np.arange(SIZE) + 0.5) / S
    cols = np.clip(((px + HALF) / GRID).astype(int), 0, N - 1)
    rows = np.clip(((HALF - py) / GRID).astype(int), 0, N - 1)
    full = mask[np.ix_(rows, cols)]
    return full ^ ndi.binary_erosion(full, iterations=2)


for i, (v, ia, ib) in enumerate(chosen):
    meta = load_meta(v)
    cx, cy = centroid_m(masks[f"{v}_ref"])
    src = Image.open(CROPS / f"{v}.jpg").convert("RGB")
    mpp, cc = meta["mpp"], src.size[0] / 2
    box = (round(cc + (cx - VIEW) / mpp), round(cc - (cy + VIEW) / mpp), round(cc + (cx + VIEW) / mpp), round(cc - (cy - VIEW) / mpp))
    tile = src.crop(box).resize((SIZE, SIZE), Image.LANCZOS).convert("RGBA")
    layer = np.zeros((SIZE, SIZE, 4), np.uint8)
    for name, col in (("A", (255, 214, 10)), ("B", (0, 220, 255)), ("ref", (74, 222, 128))):
        m = masks[f"{v}_{name}"]
        if not m.any():
            continue
        layer[edge_layer(m, cx, cy)] = (*col, 255)
    tile = Image.alpha_composite(tile, Image.fromarray(layer))
    d = ImageDraw.Draw(tile)
    vx, vy = (0 - (cx - VIEW)) * S, ((cy + VIEW) - 0) * S
    d.ellipse([vx - 6, vy - 6, vx + 6, vy + 6], outline=(255, 59, 48, 255), width=3)
    d.text((8, SIZE - 26), f"{meta['name'][:22]}  A {ia:.2f}  B {ib:.2f}", fill=(255, 255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0, 255))
    sheet.paste(tile.convert("RGB"), ((i % 3) * SIZE, (i // 3) * SIZE))
sheet.save(OUT / "compare.jpg", quality=90)
print(OUT / "compare.jpg", [(v, round(a, 2), round(b, 2)) for v, a, b in chosen])
