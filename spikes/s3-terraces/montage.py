"""Contact sheets: four venues per image (2x2), each cropped to +-HALF metres around the venue point.

  python montage.py <selected.json> [--ref] [--half 16] [--bright] [--start 0] [--count 4]

Writes data/sheets/<n>.jpg. With --ref, reference polygons (data/reference.json) are drawn on top.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
CROPS = HERE / "data" / "crops"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def tile(vid, name, half, size, ref, bright, cx=0.0, cy=0.0):
    meta = json.loads((CROPS / f"{vid}.meta.json").read_text())
    mpp = meta["mpp"]
    img = Image.open(CROPS / f"{vid}.jpg").convert("RGB")
    c = img.size[0] / 2
    r = half / mpp
    ox, oy = cx / mpp, -cy / mpp
    view = img.crop((round(c + ox - r), round(c + oy - r), round(c + ox + r), round(c + oy + r))).resize((size, size), Image.LANCZOS)
    if bright:
        import numpy as np
        a = (np.asarray(view, dtype=float) / 255) ** 0.5
        view = Image.fromarray((a * 255).astype("uint8"))
    view = view.convert("RGBA")
    s = size / (2 * half)
    to_px = lambda x, y: ((x - cx + half) * s, (cy + half - y) * s)
    over = Image.new("RGBA", view.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    g = 2 if half <= 12 else 4
    for m in range(int((cx - half) // g * g), int(cx + half) + 1, g):
        a = 90 if m % (2 * g) == 0 else 45
        d.line([to_px(m, cy - half), to_px(m, cy + half)], fill=(255, 255, 255, a), width=1)
    for m in range(int((cy - half) // g * g), int(cy + half) + 1, g):
        a = 90 if m % (2 * g) == 0 else 45
        d.line([to_px(cx - half, m), to_px(cx + half, m)], fill=(255, 255, 255, a), width=1)
    for poly in ref.get(vid, {}).get("polys", []):
        pts = [to_px(x, y) for x, y in poly]
        d.polygon(pts, fill=(255, 60, 200, 55))
        d.line(pts + pts[:1], fill=(255, 60, 200, 255), width=3)
    vx, vy = to_px(0, 0)
    d.ellipse([vx - 6, vy - 6, vx + 6, vy + 6], outline=(255, 40, 40, 255), width=2)
    view = Image.alpha_composite(view, over)
    d = ImageDraw.Draw(view)
    f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)
    for m in range(int((cx - half) // (2 * g) * 2 * g), int(cx + half) + 1, 2 * g):
        px, _ = to_px(m, 0)
        d.text((px + 2, 2), str(m), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))
    for m in range(int((cy - half) // (2 * g) * 2 * g), int(cy + half) + 1, 2 * g):
        _, py = to_px(0, m)
        d.text((2, py + 1), str(m), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))
    d.text((6, size - 24), f"{vid} {name[:26]}", fill=(255, 255, 255, 255), font=f, stroke_width=3, stroke_fill=(0, 0, 0, 255))
    return view.convert("RGB")


def main():
    if sys.argv[1] == "--spec":  # list of {"id", "cx", "cy", "half"}; names come from the crop metadata
        specs = json.loads(sys.argv[2] if sys.argv[2].startswith("[") else Path(sys.argv[2]).read_text())
        ref = json.loads((HERE / "data" / "reference.json").read_text()) if "--ref" in sys.argv else {}
        out = Path(arg("--out", HERE / "data" / "sheets" / "spec.jpg"))
        out.parent.mkdir(parents=True, exist_ok=True)
        size = 640
        sheet = Image.new("RGB", (size * 2, size * ((len(specs) + 1) // 2)))
        for i, sp in enumerate(specs):
            name = json.loads((CROPS / f"{sp['id']}.meta.json").read_text())["name"]
            t = tile(sp["id"], name, sp["half"], size, ref, "--bright" in sys.argv or sp.get("bright", False), sp["cx"], sp["cy"])
            sheet.paste(t, ((i % 2) * size, (i // 2) * size))
        sheet.save(out, quality=88)
        print(out)
        return
    venues = json.loads((HERE / "data" / sys.argv[1]).read_text())
    half = float(arg("--half", 16))
    start, count = int(arg("--start", 0)), int(arg("--count", 4))
    ref = json.loads((HERE / "data" / "reference.json").read_text()) if "--ref" in sys.argv else {}
    out = Path(arg("--out", HERE / "data" / "sheets" / f"{Path(sys.argv[1]).stem}-{start}.jpg"))
    out.parent.mkdir(parents=True, exist_ok=True)
    sel = venues[start:start + count]
    size = 640
    sheet = Image.new("RGB", (size * 2, size * ((len(sel) + 1) // 2)))
    for i, v in enumerate(sel):
        sheet.paste(tile(v["id"], v["name"], half, size, ref, "--bright" in sys.argv), ((i % 2) * size, (i // 2) * size))
    sheet.save(out, quality=88)
    print(out)


main()
