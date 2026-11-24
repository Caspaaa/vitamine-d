"""Download the UrbIS DSM + DTM GeoTIFF tiles (1 km, 0.5 m, EPSG:31370) around a tile code.

Usage: python fetch_tiles.py 148170 [radius_km=1]
Tile code = <x km><y km> in Belgian Lambert 72 (e.g. 148170 = x 148 km, y 170 km).
"""
import re
import sys
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FEEDS = {
    "dsm": "https://urbisdownload.datastore.brussels/atomfeed/8c2d921e-6a53-11ed-bfb5-010101010000-en.xml",
    "dtm": "https://urbisdownload.datastore.brussels/atomfeed/1d7bd49d-fe83-4388-af85-6f5dc8ec7909-en.xml",
}
RAW = Path(__file__).parent / "data" / "raw"


def feed_urls(kind):
    xml = urllib.request.urlopen(FEEDS[kind]).read().decode("utf-8-sig")
    urls = re.findall(r'<link rel="section" href="([^"]+\.zip)"', xml)
    return {m.group(1): u for u in urls if (m := re.search(r"_(\d{6})_", u))}


def download(args):
    kind, code, url = args
    out = RAW / kind / f"{code}.tif"
    tfw = out.with_suffix(".tfw")
    if out.exists() and tfw.exists():
        return f"{kind} {code}: cached"
    out.parent.mkdir(parents=True, exist_ok=True)
    zpath = out.with_suffix(".zip")
    urllib.request.urlretrieve(url, zpath)
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        tif = next(n for n in names if n.lower().endswith((".tif", ".tiff")))
        wld = next(n for n in names if n.lower().endswith(".tfw"))
        out.write_bytes(z.read(tif))
        # The GeoTIFF has no embedded georeferencing: GDAL picks up this sidecar world file.
        tfw.write_bytes(z.read(wld))
    zpath.unlink()
    return f"{kind} {code}: ok ({out.stat().st_size / 1e6:.1f} MB)"


def main():
    center = sys.argv[1]
    radius = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    cx, cy = int(center[:3]), int(center[3:])
    wanted = [f"{cx + dx}{cy + dy}" for dx in range(-radius, radius + 1) for dy in range(-radius, radius + 1)]
    jobs = []
    for kind in FEEDS:
        urls = feed_urls(kind)
        for code in wanted:
            if code in urls:
                jobs.append((kind, code, urls[code]))
            else:
                print(f"{kind} {code}: not in feed (outside the region)")
    with ThreadPoolExecutor(6) as pool:
        for line in pool.map(download, jobs):
            print(line)


if __name__ == "__main__":
    main()
