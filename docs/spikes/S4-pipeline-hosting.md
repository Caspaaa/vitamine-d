# Spike S4 — Pipeline operations and free hosting: result

**Verdict: GO.** All of Brussels fits the free tiers with a wide margin, the whole data chain runs unattended on a free GitHub runner, and every Cloudflare Pages limit was tested for real. Four surprises to design around (all cheap): a missing tile returns **200 + HTML** unless a `404.html` exists; **range requests are not supported** (the PMTiles basemap fallback must change); header rules **add up** instead of overriding; and the public **Overpass servers were unreliable from a runner in 2 of 3 runs**, so the venue extract must be cached.

Code: [spikes/s4-pipeline/](../../spikes/s4-pipeline/) · CI: [.github/workflows/](../../.github/workflows/) · Spec: [SPEC.md §6.1, §7, §8](../SPEC.md)

## The data chain, measured on all of Brussels

| Step | What | Your Mac (M3, 8 cores) | Free GitHub runner (4 vCPU, 15 GB) |
|---|---|---|---|
| 1. Download | 216 DSM + 216 DTM zips (4.5 GB) → compressed cache | 12.6 min (6.0 MB/s), 268 MB RAM, 3.0 GB disk | **3.4 min** (22.4 MB/s), 306 MB RAM |
| 2. Tiles | z17 PNG height tiles | **1.9 min** (7 procs), 180 MB RAM | 7.2 min (3 procs), 274 MB RAM |
| 3. Seed terraces | Overpass venues + UrbIS footprints + method A (S3) | 32 s (venues cached) | 93 s; **468 s** when Overpass was overloaded (retries) |
| 4. Horizons + snapshot | 29,448 horizon points → 204 snapshot files | 64 s (tiles on disk), 132 s (tiles from Pages) | 145 s (tiles from Pages), 562 MB RAM |

- **Steps 1–2 are one-off** (a new UrbIS release every few years). **Steps 3–4 are the frequent job** (every batch of terrace edits). A whole run of steps 3–4 on a free runner is about **5 minutes**.
- **1 km² test run:** 7 s to download a DSM + DTM tile, 1.7 s to build its 42 + 42 tiles.
- The slow part is the **UrbIS server**, not computing: the Mac got 6 MB/s, the runner 22 MB/s from the same server.
- The Mac has only **16 GiB free (97 % full)**, so the compressed raw cache (3.0 GB) is deleted after a run; tiles are rebuilt from CI when needed.

### Output volumes (the real numbers; S1 had extrapolated 150 MB / 4,300 files)
| Set | Files | Size | Per file |
|---|---|---|---|
| DSM tiles (surface) | 4,931 | 177 MB | 35 KB mean, 65 KB max |
| DTM tiles (bare ground) | 4,931 | 48 MB | 9.5 KB mean |
| Place snapshot (3,272 venues) | 204 | 2.8 MB brotli (6.4 MB raw) | 863 B per terrace |
| Tile indexes | 2 | 2.4 KB each | |
| **Total static data** | **≈ 10,100** | **≈ 230 MB** | half of the 20,000-file limit |

The tile count is higher than estimated (4,931 vs 4,300) because the regional boundary tiles are clipped and partial. A second DSM version in the same project would use 19,700 files, so **only one version is published at a time** (or one Pages project per version).

### Correctness
- **Same tiles as S1:** of the 256 tiles both pipelines produce, 210 are identical. The other 46 all lie along the edges of the S1 mosaic: the westernmost column (16 tiles) where S1 had no source data at all, the next column (16) and one border row (14), where S1's bilinear sampling had no neighbours (0.04–0.25 % of pixels differ, up to 2.75 m). The new builder reads source windows per tile instead of a mosaic, so it has no edge effects.
- **Same horizons as S2:** the tile-lazy job gives 99.77 % identical profile bytes on 739 terraces vs the whole-area S2 loader (max difference one 0.5° step).
- **Source tiles at the regional boundary are clipped** (as narrow as 15 px) but sit on the same 0.5 m grid; the builder handles any size. The raw `.tif` files mark no-data as −3.4e38 and carry no coordinate system; the cache converts these to NaN and embeds EPSG:31370.

### Venues (all of Brussels)
3,330 OSM venues (3,272 named): 1,953 restaurants, 630 cafés, 389 pubs, 351 bars, 7 beer gardens. **An outdoor-seating tag on 31 % of venues**: 757 `yes`, about 130 other values (`sidewalk`, `pedestrian_zone`, `terrace`…), 156 `no`; 2,289 (69 %) untagged. The spec's "≈ 3,300 venues" was right. Method A found a building within 12 m for 97 % (104 venues, mostly in parks and kiosks, got a 4 m fallback square). Footprints: 145 one-km cells, 157 MB, 43 s.

## Cloudflare Pages (free), tested on a real project
Created and deployed with `wrangler` on a free account; no payment step appeared. A new account was **not** blocked from creating a project (the docs mention a 48-hour limit on new projects).

### Limits (tested)
| Limit | Result |
|---|---|
| File size | exactly 25 MiB accepted; 25 MiB + 1 byte **rejected** by wrangler |
| File count | 20,000 files accepted (81 s); 20,001 **rejected** |
| Full Brussels set | 9,867 files, 233 MB: first deploy **73 s** |
| Re-deploy after changing one tile | **15 s**, uploads 1 file (content hashing) |
| Deploys per month | the 500 limit is for **Git builds**; the Direct Upload docs list no monthly cap (6 successful deploys during the tests, no warning) |
| Requests / bandwidth | docs: static requests free and **unlimited**; a soft clause lets Cloudflare limit "undue burden" |
| Terms | Pages is part of the Developer Platform, which "can be used to host content"; no commercial-use clause in the service terms; a `pages.dev` name can be changed with one week's notice, so use a **custom domain** |

### Behaviour (tested with curl)
| Question | Result | What to do |
|---|---|---|
| CORS | `_headers` with `Access-Control-Allow-Origin: *` works (also on 404s). A CORS **preflight (OPTIONS) returns 405** | tile requests must be **simple GETs** with no custom headers |
| Caching | `Cache-Control: public, max-age=31536000, immutable` via `_headers`; ETag + `304` work | version the path (`/urbis-2021/…`), cache forever |
| Compression | JSON is served with brotli; PNG as is | none |
| HTTP | HTTP/2 and HTTP/3 advertised; served from the Amsterdam edge | none |
| **Missing file** | **`200` + the HTML page** (the site is treated as a single-page app), cached as `immutable` by the header rule | add a **`404.html`**: then a real `404` with `cache-control: no-store` |
| **Overlapping header rules** | values are **joined**: `public, max-age=31536000, immutable, public, max-age=300` | use non-overlapping paths, or `! Cache-Control` to detach a header (tested, works) |
| **Range requests** | **not supported**: `Range: bytes=100-199` returns `200` with all 25 MiB and no `Accept-Ranges` | no PMTiles-over-HTTP; see decisions |
| Python's default user agent | **403** | always send a User-Agent in pipeline code |

### Speed (from your Mac in Belgium, HTTP/2, 150–200 random DSM tiles)
| | Cold (first fetch at the edge) | Warm |
|---|---|---|
| One tile | p50 ≈ 230 ms | p50 45–70 ms |
| 150 tiles (5.3 MB), 20 in parallel | 1.9 s (80 tiles/s) | 0.75 s (200 tiles/s) |
| 150 tiles, 6 in parallel | 5.5 s | 1.4 s |
A cold phone view of 400 × 800 m plus a 500 m ray margin is about 100 DSM tiles (≈ 3.5 MB), so roughly 1–2 s on a good connection. A real phone on 4G was not measured.

## GitHub Actions (free), real runs on `Caspaaa/vitamine-d`
- **Public repo: standard runners are free and unlimited** (4 vCPU, 16 GB RAM). A private repo draws from a monthly "included compute usage" budget with overage billed; I could not confirm overage is blocked without a card on file, so **the repo is public** (the data and code are meant to be open anyway).
- **Limits:** 6 hours per job, 35 days per workflow run, 10 GB cache per repo. The docs say 14 GB disk; the runner showed 91 GB free on `/` (not relied on).
- **Observed:** tile build 11 min, snapshot job about 5 min, both green. The tile job needs no cache because it streams from the UrbIS server.
- **Scheduled workflows:** run only on the default branch, can be **delayed or dropped at the top of the hour** (use an odd minute), and in public repos are **automatically disabled after 60 days without repository activity**.
- **Runners are IPv4-only:** every IPv6 request failed instantly (`Network is unreachable`), including to Cloudflare. All data hosts answered over IPv4 (UrbIS footprints 200, Pages 200 in 0.15 s).
- **Overpass is the weak link from a runner.** Run 1: 5 failures with `Network is unreachable`. Run 2: first try worked. Run 3: `overpass-api.de` 502, `kumi.systems` timeout, `private.coffee` empty answer, `maps.mail.ru` 504, then `overpass-api.de` worked in the second round: the seed step took **468 s instead of 93 s**. The import now tries four public instances in rounds, but the real fix is to **not depend on it for every run**: keep the venue extract cached and refresh it in its own weekly job.
- **A CI pitfall:** `cmd | tee log` hid a failing step (the job reported success while producing nothing). All workflows now use `bash -eo pipefail` and `time -o`.
- **Not tested:** deploying from CI to Pages. It needs a Cloudflare API token (scope: Pages edit) and the account id as repository secrets; the same `wrangler pages deploy` command ran fine locally.

## Supabase keep-alive
Free projects "may be paused" after 7 days of low activity (docs wording is soft). A GitHub cron would ping it, but that cron can be **silently disabled** after 60 idle days, so a single pinger is not enough. Cloudflare Workers Free allows **5 cron triggers** and 100,000 requests/day, so a daily Worker ping is a free second pinger (and has a spending limit setting). Recommended: both, plus the app's own traffic. Not built (no Supabase project yet).

## Decisions
1. **Data host:** Cloudflare Pages Free, a **separate "data" project** from the app, plain `z/x/y` files under a versioned path, with `404.html` and a `_headers` file with non-overlapping rules. One version at a time. Deploys are batched but cheap (15 s incremental).
2. **Tiles, one-off:** `fetch_raw.py` + `build_tiles.py`, run by CI (11 min) or the Mac. **Frequent job:** `seed_places.py` + `horizons.mts` on a free runner from the published tiles (cache the 230 MB with `actions/cache` if download time matters).
3. **Basemap fallback changes** (range requests do not work on Pages): publish the Brussels z0–14 vector extract as plain `z/x/y` files (about 150–200 tiles, well under the file limit), or load the 10.6 MB archive whole through a custom source. Not needed unless OpenFreeMap stops.
4. **Client rules:** simple GET requests only, no custom headers; read the tile `index.json` and never request tiles that are not listed.
5. **DTM tiles can wait:** the DTM set (48 MB) is only needed for the terrace editor preview, not for the shadow map. Packing it into the unused B channel of the DSM tile would halve the file count, but is not needed (10,100 files < 20,000).
6. Keep the repo public; schedule crons at odd minutes; add the second keep-alive in M5.
7. **Venue import is its own job** (weekly, tolerant of failure) that writes a cached extract (committed file or Pages asset); the frequent seed + horizon job reads the cache and never calls Overpass. OSM edits are small (3,330 → 3,333 elements between two runs three hours apart on 24 Nov).

## Caveats
- Speed numbers are from one connection in Belgium, not from phones or other countries.
- Three CI runs are an anecdote, not a reliability measurement: Overpass could be better or worse at other times.
- The test project and the CI default point at `vitamine-d-s4-test.pages.dev`, which is deleted after the spike; set the repository variable `TILES_URL` once the real data project exists.
- UrbIS downloads at 6 to 22 MB/s depending on where you are; a slow day could double the one-off step.

## Reproduce
```
cd spikes/s4-pipeline                      # python = ../s1-shadow/.venv/bin/python
python fetch_raw.py --kind dsm dtm --codes all    # 4.5 GB download, resumable
python build_tiles.py --kind dsm dtm              # data/raw -> out/{dsm,dtm}/17/x/y.png + index.json
python compare_s1.py                              # versus the S1 tiles
python seed_places.py --fetch-venues              # venues + footprints -> data/terraces-seed.json
../s2-horizon/node_modules/.bin/tsx horizons.mts  # TILES=<folder or https URL>; -> snapshot/places/15/x/y.json
../s2-horizon/node_modules/.bin/tsx check_horizons.mts
cd hosting && npx wrangler login && python3 burst.py https://<project>.pages.dev/urbis-2021 150 6 20
```
