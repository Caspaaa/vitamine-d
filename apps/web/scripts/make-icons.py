"""Draws the app icons (a sun with a D). Run with the pipeline venv: ../../spikes/s1-shadow/.venv/bin/python scripts/make-icons.py"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
AMBER, DEEP, NAVY, SAND = (255, 183, 3), (251, 133, 0), (20, 33, 61), (255, 248, 230)


def sun(size, scale=1.0, rounded=True):
    s = size * 4  # draw large, then downsample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22) if rounded else 0, fill=AMBER)
    c = s / 2
    r_disc, r_in, r_out = 0.25 * s * scale, 0.32 * s * scale, 0.43 * s * scale
    for i in range(12):
        a = math.radians(i * 30)
        p0 = (c + r_in * math.sin(a), c - r_in * math.cos(a))
        p1 = (c + r_out * math.sin(a), c - r_out * math.cos(a))
        d.line([p0, p1], fill=SAND, width=int(0.045 * s * scale))
        for p in (p0, p1):
            d.ellipse([p[0] - 0.0225 * s * scale, p[1] - 0.0225 * s * scale, p[0] + 0.0225 * s * scale, p[1] + 0.0225 * s * scale], fill=SAND)
    d.ellipse([c - r_disc, c - r_disc, c + r_disc, c + r_disc], fill=SAND)
    font = None
    for path in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf", "/Library/Fonts/Arial Bold.ttf"):
        try:
            font = ImageFont.truetype(path, int(0.3 * s * scale), index=1) if path.endswith("ttc") else ImageFont.truetype(path, int(0.3 * s * scale))
            break
        except Exception:
            continue
    d.text((c, c + 0.01 * s), "D", fill=NAVY, font=font or ImageFont.load_default(), anchor="mm")
    return img.resize((size, size), Image.LANCZOS)


sun(192).save(OUT / "icon-192.png")
sun(512).save(OUT / "icon-512.png")
sun(512, scale=0.82, rounded=False).save(OUT / "maskable-512.png")  # full-bleed, artwork inside the 80% safe zone
sun(180, rounded=False).save(Path(__file__).resolve().parent.parent / "src" / "app" / "apple-icon.png")
sun(512).save(Path(__file__).resolve().parent.parent / "src" / "app" / "icon.png")
print("icons written")
