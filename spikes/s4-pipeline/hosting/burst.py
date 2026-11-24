"""Burst-download random tiles from a deployed site over HTTP/2 with curl and summarise latency and throughput.

  python burst.py https://<site>.pages.dev/urbis-2021 [n=200] [concurrency=6 20] [--seed N]
Tiles are drawn from <base>/<kind>/index.json. Each run uses a fresh set of tiles when --fresh is given (cold edge cache).
"""
import json
import random
import statistics
import subprocess
import sys
import time
import urllib.request

args = [a for a in sys.argv[1:] if not a.startswith("--")]
base = args[0].rstrip("/")
n = int(args[1]) if len(args) > 1 else 200
conc = [int(c) for c in args[2:]] or [6, 20]
seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 1
fresh = "--fresh" in sys.argv
index = json.load(urllib.request.urlopen(urllib.request.Request(base + "/dsm/index.json", headers={"User-Agent": "vitamine-d-s4/0.1"})))
all_tiles = [(x, int(y)) for y, runs in index["rows"].items() for a, b in runs for x in range(a, b + 1)]
print(f"{len(all_tiles)} tiles in the index")


def run(urls, par):
    t0 = time.time()
    out = subprocess.run(
        ["curl", "-s", "-Z", "--parallel-max", str(par), "--http2", "-w", "%{http_code} %{time_total} %{size_download} %{http_version} %{remote_ip}\n", *[x for u in urls for x in ("-o", "/dev/null", u)]],
        capture_output=True, text=True).stdout.strip().splitlines()
    wall = time.time() - t0
    rows = [l.split() for l in out]
    ok = [r for r in rows if r[0] == "200"]
    times = sorted(float(r[1]) * 1000 for r in ok)
    size = sum(int(r[2]) for r in ok)
    return wall, len(rows), len(ok), times, size, {r[3] for r in rows}


rng = random.Random(seed)
for par in conc:
    for label in ("cold", "warm"):
        if label == "cold" or fresh:
            pick = rng.sample(all_tiles, n)
            urls = [f"{base}/dsm/17/{x}/{y}.png" for x, y in pick]
        wall, total, ok, times, size, ver = run(urls, par)
        print(f"concurrency {par:2d} {label}: {ok}/{total} ok, wall {wall:.2f}s, {size / 1e6:.1f} MB -> {size / 1e6 / wall:.1f} MB/s, "
              f"{ok / wall:.0f} tiles/s | per-tile ms p50 {statistics.median(times):.0f} p95 {times[int(len(times) * .95) - 1]:.0f} max {times[-1]:.0f} | http {','.join(sorted(ver))}")
