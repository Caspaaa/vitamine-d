"""Step 1 of the height-tile pipeline: download the UrbIS DSM / DTM 1 km tiles into a local cache.

Each tile is a 2000 x 2000 float32 GeoTIFF (0.5 m, Belgian Lambert 72) whose only georeferencing is a world file.
The cache keeps one compressed, tiled GeoTIFF per tile with the CRS and transform *embedded* and nodata = NaN,
so later steps need no sidecar files. Safe to re-run: existing tiles are skipped, partial files never appear.

  python fetch_raw.py --kind dsm dtm --codes all
  python fetch_raw.py --kind dsm --codes 148170 148171          # a few tiles
  python fetch_raw.py --kind dsm dtm --bbox 147 169 149 171      # km x0 y0 x1 y1 (inclusive)
"""
import argparse
import os
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS

HERE = Path(__file__).parent
RAW = Path(os.environ.get("RAW_DIR", HERE / "data" / "raw"))
FEEDS = {
    "dsm": "https://urbisdownload.datastore.brussels/atomfeed/8c2d921e-6a53-11ed-bfb5-010101010000-en.xml",
    "dtm": "https://urbisdownload.datastore.brussels/atomfeed/1d7bd49d-fe83-4388-af85-6f5dc8ec7909-en.xml",
}
UA = {"User-Agent": "vitamine-d-pipeline/0.1 (+personal open-data project)"}
NODATA_BELOW = -1000.0  # the source files mark "no data" with -3.4e38


def feed_urls(kind):
    req = urllib.request.Request(FEEDS[kind], headers=UA)
    xml = urllib.request.urlopen(req, timeout=60).read().decode("utf-8-sig")
    urls = re.findall(r'<link rel="section" href="([^"]+\.zip)"', xml)
    return {m.group(1): u for u in urls if (m := re.search(r"_(\d{6})_", u))}


def download(job):
    kind, code, url = job
    out = RAW / kind / f"{code}.tif"
    if out.exists():
        return code, 0, 0.0, "cached"
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with tempfile.TemporaryDirectory(dir=RAW) as tmp:
        tmp = Path(tmp)
        zpath = tmp / "t.zip"
        for attempt in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(zpath, "wb") as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                with zipfile.ZipFile(zpath) as z:
                    if z.testzip() is None:
                        break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        nbytes = zpath.stat().st_size
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            z.extract(next(n for n in names if n.lower().endswith((".tif", ".tiff"))), tmp)
            z.extract(next(n for n in names if n.lower().endswith(".tfw")), tmp)
        tif = next(p for p in tmp.rglob("*") if p.suffix.lower() in (".tif", ".tiff"))
        with rasterio.open(tif) as src:  # the .tfw next to it supplies the transform
            data = src.read(1)
            transform = src.transform
        data[data < NODATA_BELOW] = np.nan
        part = out.with_suffix(".part")
        with rasterio.open(part, "w", driver="GTiff", height=data.shape[0], width=data.shape[1], count=1, dtype="float32",
                           crs=CRS.from_epsg(31370), transform=transform, nodata=float("nan"), tiled=True,
                           blockxsize=256, blockysize=256, compress="deflate", predictor=3, zlevel=6) as dst:
            dst.write(data, 1)
        part.replace(out)
    return code, nbytes, time.time() - t0, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", nargs="+", default=["dsm", "dtm"], choices=list(FEEDS))
    ap.add_argument("--codes", nargs="*", default=None, help="'all' or explicit 6-digit codes")
    ap.add_argument("--bbox", nargs=4, type=int, metavar=("X0", "Y0", "X1", "Y1"), help="km, inclusive")
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    jobs = []
    for kind in a.kind:
        urls = feed_urls(kind)
        if a.bbox:
            x0, y0, x1, y1 = a.bbox
            wanted = [c for c in urls if x0 <= int(c[:3]) <= x1 and y0 <= int(c[3:]) <= y1]
        elif a.codes and a.codes != ["all"]:
            wanted = a.codes
        else:
            wanted = list(urls)
        for c in wanted:
            if c in urls:
                jobs.append((kind, c, urls[c]))
            else:
                print(f"{kind} {c}: not in the feed")
    t0 = time.time()
    done = 0
    total_dl = 0
    with ThreadPoolExecutor(a.threads) as pool:
        for code, nbytes, sec, state in pool.map(download, jobs):
            done += 1
            total_dl += nbytes
            if state == "ok":
                print(f"[{done}/{len(jobs)}] {code} {nbytes / 1e6:.1f} MB in {sec:.0f}s", flush=True)
    dt = time.time() - t0
    print(f"{len(jobs)} tiles, downloaded {total_dl / 1e9:.2f} GB in {dt:.0f}s ({total_dl / 1e6 / max(dt, 1):.1f} MB/s)")


if __name__ == "__main__":
    main()
