"""Zoomed, finely gridded view of a crop, optionally with the reference polygons drawn on top.

  python zoom.py <id> <cx> <cy> <half_m> [--ref] [--out PATH]

cx, cy and half_m are metres relative to the venue point (x east, y north). Output: data/zoom/<id>.png
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
CROPS = HERE / "data" / "crops"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    vid, cx, cy, half = args[0], float(args[1]), float(args[2]), float(args[3])
    show_ref = "--ref" in sys.argv
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else HERE / "data" / "zoom" / f"{vid}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = json.loads((CROPS / f"{vid}.meta.json").read_text())
    mpp = meta["mpp"]
    img = Image.open(CROPS / f"{vid}.jpg").convert("RGB")
    c = img.size[0] / 2
    box = (c + (cx - half) / mpp, c - (cy + half) / mpp, c + (cx + half) / mpp, c - (cy - half) / mpp)
    size = 800
    view = img.crop(tuple(round(b) for b in box)).resize((size, size), Image.LANCZOS).convert("RGBA")
    if "--bright" in sys.argv:  # lift shadows so tables in shade become visible
        import numpy as np
        a = np.asarray(view.convert("RGB"), dtype=float) / 255
        a = np.clip((a ** 0.45) * 1.05, 0, 1)
        view = Image.fromarray((a * 255).astype("uint8")).convert("RGBA")
    s = size / (2 * half)
    to_px = lambda x, y: ((x - (cx - half)) * s, ((cy + half) - y) * s)
    over = Image.new("RGBA", view.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    step = 1 if half <= 12 else 2
    lab = 2 if half <= 12 else 4
    x = int(cx - half) - 1
    while x <= cx + half + 1:
        for (a, b) in ((to_px(x, cy - half - 1), to_px(x, cy + half + 1)),):
            d.line([a, b], fill=(255, 255, 255, 90 if x % lab == 0 else 40), width=1)
        x += step
    y = int(cy - half) - 1
    while y <= cy + half + 1:
        d.line([to_px(cx - half - 1, y), to_px(cx + half + 1, y)], fill=(255, 255, 255, 90 if y % lab == 0 else 40), width=1)
        y += step
    ref = json.loads((HERE / "data" / "reference.json").read_text()) if show_ref and (HERE / "data" / "reference.json").exists() else {}
    for poly in ref.get(vid, {}).get("polys", []):
        pts = [to_px(px, py) for px, py in poly]
        d.polygon(pts, fill=(255, 60, 200, 60))
        d.line(pts + pts[:1], fill=(255, 60, 200, 255), width=3)
        for p in pts:
            d.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=(255, 255, 0, 255))
    for r in json.loads((CROPS / f"{vid}.bld.json").read_text()):
        pts = [to_px(px, py) for px, py in r]
        d.line(pts + pts[:1], fill=(0, 230, 255, 150), width=1)
    view = Image.alpha_composite(view, over)
    d = ImageDraw.Draw(view)
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
    except Exception:
        f = ImageFont.load_default()
    m = int(cx - half)
    while m <= cx + half:
        if m % lab == 0:
            px, _ = to_px(m, 0)
            d.text((px + 2, 2), str(m), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))
        m += 1
    m = int(cy - half)
    while m <= cy + half:
        if m % lab == 0:
            _, py = to_px(0, m)
            d.text((2, py + 1), str(m), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))
        m += 1
    vx, vy = to_px(0, 0)
    if 0 <= vx < size and 0 <= vy < size:
        d.ellipse([vx - 7, vy - 7, vx + 7, vy + 7], outline=(255, 40, 40, 255), width=3)
    view.convert("RGB").save(out)
    print(out)


main()
