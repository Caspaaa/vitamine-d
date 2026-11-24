# Vitamine D — Product & Architecture Spec (v0.1)

> Name: **Vitamine D** (no domain purchase planned: free `*.vercel.app` address). Moderator: the product owner. Status: draft for review, nothing built yet.
> Facts marked ✓ were probed on 2026-11-23 (endpoints answered / docs read). Facts marked **[?]** are unverified and listed in [§14](#14-open-questions--risks).

## 1. Goal

Answer one question without effort: **"Where can I sit outside in the sun, near me, right now (or at a time I choose)?"**

Unlike a browse-a-map tool (jeveuxdusoleil, as described by the product owner: "very manual"), the app **suggests** places: it ranks nearby terraces, parks, squares and quays by how much usable sun they get, how far they are, and whether they are open.

- **Launch area:** Brussels-Capital Region. Then Belgium, then France.
- **Primary device:** mobile-first PWA; works on desktop.
- **Languages (day one):** FR, NL, EN, DE, ES.
- **Cost:** **zero, as a hard rule** (see the zero-cost rule in §5). **No monetisation planned** (no ads, no paid tiers). The only revenue idea is an optional "buy me a coffee" donation link (see §13).
- **Weather:** not in v1 (geometric sun only); the design leaves a hook for it.

## 2. Scope

### In v1
| # | Feature | Notes |
|---|---|---|
| F1 | Map with 3D buildings, trees and **live shadows** for any date/time, with a time scrubber, a date picker and a "now" button | Original brief; core |
| F2 | Geolocation + address search | Location never leaves the device |
| F3 | **"Sun now" suggestions**: top places ranked by sun left × travel time × open now | One tap, no filters needed |
| F4 | **Sun window per venue**: "Sunny until 17:40 (2h35 left)" + a day timeline bar | Also "sun starts at 15:10 for 1h50" |
| F5 | Place types: bars/cafés, restaurants, parks & gardens, squares, benches/riverbanks/quays, rooftops | |
| F6 | **Terrace polygons**, seeded automatically, **editable by the community** on a 5 cm aerial view, with history and moderation | Original brief: "adjust manually" |
| F7 | Seasonal trees (leaf-on/leaf-off) | |
| F8 | **Shade mode** (invert the logic for hot days) | |
| F9 | Filters: type, open now, dog/kid-friendly, heated terrace, wheelchair access | Data is sparse, see §14 |
| F10 | Walk / bike toggle, travel time shown | |
| F11 | Share link: "Meet at this terrace at 17:00" with the sun forecast | |
| F12 | Street-level photo of the venue (Panoramax) | |
| F13 | Accounts (Google sign-in; magic link only if a free email sender is found): favourites, contributions | Optional login |
| F14 | Venue owner "claim" flow | **Schema + UX stub only in v1**; its value is data quality (owners keep their terrace accurate), not revenue |
| F15 | Public open dataset of Brussels terraces + push corrections back to OSM | Export job in v1, OSM flow can be manual first |

> **Scope note.** The time scrubber (F1) and the community terrace editor (F6) were unticked in the last questionnaire but are explicit requirements of the original brief, so they stay in v1. Say so if you want them out.

### Not in v1 (backlog)
Weather-aware sun score (Open-Meteo) · push notifications ("your favourite terrace gets sun in 20 min") · sundowner mode · per-table heatmap · live "still sunny here" check-ins · "chase the sun" multi-stop route · other regions.

## 3. Key product rules

### 3.1 What "sunny" means (default: "Smart")
- Sample the terrace with a **3×3 grid of points** (odd on purpose: with an even grid "exactly half lit" sits on the threshold and biases the result; S2). A point is **lit** if the sun is above its horizon. Trees attenuate light by a seasonal factor (§6.4).
- A place is **sunny** at time *t* when **≥50% of its sample points are lit**; once sunny it stays sunny **until fewer than 35% are lit** (hysteresis, so a window does not end the instant half the tables go into shade).
- A **sun window** is a continuous sunny interval of **≥30 min**. Gaps ≤5 min are merged (a chimney shadow is not an interruption). Windows are computed at **1-minute resolution**.
- A terrace that hovers around 50% lit for a long time is genuinely ambiguous (S2: ≈1% of terrace-days flip between "sunny all day" and "a gap"): show the **lit-share timeline** and a "partly sunny" state, not only binary windows.
- **Shade mode** uses the mirror rule: ≥50% of the terrace is *unlit* for ≥30 min.
- All thresholds are constants in one config file (user-adjustable later).

### 3.2 Suggestions ("Sun now")
Inputs: user position (or address), mode (walk/bike), time *t₀* (default now), sun/shade mode, filters.

For each candidate place within the radius (default ≈15 min walk, ≈1.2 km; bike ≈ 15 min):
1. `travel` = straight-line distance × 1.3 ÷ speed (walk 4.8 km/h, bike 15 km/h) — **assumptions** (route-based later). Shown as "≈ 8 min".
2. `arrival = t₀ + travel`.
3. Find the first sun window that ends after `arrival`. Intersect it with the opening hours.
4. `usable` = minutes of that intersection from `max(arrival, window start)`; `wait` = minutes from `arrival` until the window starts (0 if already sunny on arrival).
5. Keep the place if `usable ≥ 30 min` and `wait ≤ 90 min`.

Score (all weights live in config; tune on a test set, §12):
```
S_sun     = min(usable, 180) / 180 × (1 − min(wait, 90) / 180)
S_near    = 1 − travel / maxTravel
S_quality = terrace confidence (verified 1.0, community 0.8, seeded 0.5) × type fit
score     = 0.55·S_sun + 0.30·S_near + 0.15·S_quality
```
Each card says **why**: "Sunny now · 2h35 left · 6 min walk · open until 23:00". Sort options: Best (default), Closest, Longest sun.

Empty state: if nothing qualifies, show the soonest sun anywhere in the radius ("Next sun: Place Flagey at 16:20"), else the best slot later today, else tomorrow.

### 3.3 Terrace confidence
`seeded` (auto-guess, "unverified" badge) → `community` (edited/confirmed by a user) → `verified` (confirmed by ≥2 users or a moderator) → `owner` (claimed by the venue). Seeded terraces rank lower and are shown with a "Is this position right? Fix it" prompt.

What the levels mean for accuracy (spike S3, [result](spikes/S3-terrace-positions.md)): a `seeded` position is typically ~3 m off, so about 89 % of its sun-minutes are labelled correctly and its window is more than 30 min wrong on about half of terrace-days; a human-corrected polygon (`community`/`verified`, ~1 m) gets about 96 % and 30 min or more wrong on about one terrace-day in five. Therefore **seeded windows are always shown as approximate** ("sunny until about 15:30", "estimated") and never as exact times.

## 4. UX outline (mobile first)

- **Home** = full-screen map + bottom sheet.
  - Sheet collapsed: three best cards. Expanded: scrollable list + filters.
  - Top: search/address field, locate-me button, sun/shade, walk/bike.
  - Bottom: time scrubber (sunrise–sunset), date chip, "Now" button, play (animates shadows).
- **Place detail**: photo (Panoramax), sun-window bar for the chosen day, opening hours, tags, travel time, "Share", "Directions" (deep link to the user's maps app), "Fix terrace", "Claim this venue".
- **Terrace editor**: full-screen map on the aerial view (**only here**, never as the normal background), polygon drawn/dragged/vertex-edited, a live shadow preview over it, "Submit".
- **Permissions**: if geolocation is denied, ask for an address; remember the last location on the device.
- **i18n**: URL prefix per locale (`/fr`, `/nl`, `/en`, `/de`, `/es`), ICU messages, automatic detection with a manual switcher. Venue names are never translated.
- **Accessibility**: shadow/sun states never rely on colour alone (icons + text); 44 px touch targets.

## 5. Chosen stack

**Zero-cost rule (hard constraint).** Nothing that costs money, now or by surprise. Concretely:
- No payment method is attached to any service. Prefer services that **throttle or pause** when the free limit is hit rather than bill: Vercel Hobby (wait 30 days after exceeding a limit ✓), Supabase Free (no charges on the Free plan ✓), Cloudflare Pages Free.
- **No paid API or tool in v1 or the roadmap**: no LLM calls, no paid maps/geocoding/routing, no paid email, no paid hosting tier, no purchased domain (the app runs on a free `*.vercel.app` address; a domain stays optional and is your call).
- **Cloudflare R2 is dropped.** Its docs require an "R2 subscription" via a checkout flow and bill usage beyond the free tier ✓; I found no hard spend cap. Static data goes to Cloudflare Pages instead (below).

| Layer | Choice | Why / caveat |
|---|---|---|
| Language | TypeScript everywhere (pnpm monorepo) | |
| Web app | **Next.js (App Router)** + Tailwind, PWA via a service worker (candidate: Serwist) | Mostly client-side; SEO pages per city/locale |
| Map | **MapLibre GL JS** + a custom WebGL layer for shadows | No native cast shadows in MapLibre ✓ → custom layer |
| Basemap | **OpenFreeMap** (free, no key, commercial use allowed ✓) | No SLA ✓. Fallback if it ever stops: a Brussels Protomaps extract z0–14 (≈10.6 MB ✓). **Range requests do not work on Cloudflare Pages** (tested in S4), so publish it as plain `z/x/y` files (≈150–200 tiles) or load the archive whole through a custom source |
| Backend/DB/Auth | **Supabase Free** (Postgres + PostGIS, auth, RLS) | Pauses after 1 week of inactivity ✓ → a free GitHub Actions cron keeps it awake **[?]**; 500 MB DB, 5 GB egress ✓ |
| Login | **Google sign-in first** (free); GitHub optional | Supabase's built-in email sender is limited to **2 emails/hour** ✓ and "not for production", so magic links are not reliable without a custom SMTP provider (free ones usually want your own domain). Apple sign-in costs $99/yr → excluded |
| Static data | **Cloudflare Pages Free** (separate project: height tiles, building tiles, place snapshots) | Max **25 MiB per file, 20,000 files per deployment** (both tested in S4); free sign-up and deploys worked without a card; static requests free and unlimited, no commercial-use clause (docs read, S4); **no range requests**; a missing file returns 200 + HTML unless a `404.html` exists; `_headers` rules add up (use `! Header` to detach). Tiles are **plain `z/x/y` files**, not one big archive. Use a custom domain (a `pages.dev` name can be changed with a week's notice) |
| App hosting | **Vercel Hobby** (free, no card) | "Personal or non-commercial use" only ✓; donation link = grey area (§13) |
| Compute (data jobs) | **GitHub Actions on a public repo** (free, unlimited standard runners; measured in S4: tile build 11 min, frequent snapshot job ≈ 5 min) or your Mac (tile build 15 min, but only 16 GiB free on disk); pipeline in **Python** (rasterio, numpy, pyproj, Pillow, shapely) + TypeScript for horizons | Raster work is much easier in Python (S1); the app and `packages/sun` stay TypeScript |
| Sun position | `suncalc` (BSD-2, maintained ✓) | |
| Geocoding | **Photon** public instance for typeahead (debounced + cached in the browser); Nominatim only for submitted (non-typeahead) fallback | Nominatim's public policy **forbids autocomplete** ✓; Photon is fair-use, no SLA, **no self-hosting** (that would cost). Brussels geocoder as a free fallback |
| Travel time | Straight-line × 1.3 (no routing service) | Free public OSRM (1 req/s ✓, fair use) possible later for the selected venue only |
| Street photos | **Panoramax** (open STAC API, CC-BY-SA, no token) ✓ | |
| Polygon editing | A MapLibre drawing lib (candidate: Terra Draw) **[?]** | verify licence/maintenance in M3 |
| Opening hours | OSM `opening_hours` syntax parser **[?]** | verify licence before adopting |
| Tests | Vitest (logic), Playwright (UI) | |

Not chosen: Google Maps/Places, Mapbox, ShadeMap (paid key on non-localhost domains ✓), Cloudflare R2, Vercel Pro, Supabase Pro, Open-Meteo commercial plans, OpenRouteService/GraphHopper paid, any LLM API.

## 6. Core design: the shadow engine

Two jobs, two techniques, one data source.

### 6.1 Single source of truth: the Brussels LiDAR surface model
UrbIS publishes a **DSM** and a **DTM** at 0.5 m (LiDAR, flown Oct 2021, CC0) ✓. The DSM already contains **buildings and all trees (including private ones)**. No building-height attribute exists elsewhere ✓, so heights come from the DSM.

Build pipeline (**Python**: rasterio/GDAL, numpy, pyproj, Pillow; run on your Mac or free GitHub Actions minutes), output published to the static host (Cloudflare Pages):
1. Download DSM + DTM GeoTIFF tiles (EPSG:31370) ✓; mosaic; reproject to EPSG:3857. *(S1: the GeoTIFFs carry no CRS; georeferencing is in a sidecar `.tfw` world file, and the 1 km tiles join exactly.)*
2. **Classify each pixel** (needed for seasonal trees; **not yet built**, the `B` channel is reserved):
   - `building` = inside a UrbIS building footprint (WFS, 247,625 features ✓) and nDSM (= DSM − DTM) > 2 m;
   - `vegetation` = outside footprints and flagged *high vegetation* by the Bruxelles Environnement vegetation raster (2 m, CC-BY ✓) with nDSM > 2 m;
   - `other structure` = remaining nDSM > 2 m (walls, canopies, cars…) treated as opaque;
   - `ground` otherwise.
3. Encode as **height tiles** at **z17 (≈0.75 m/pixel)**: PNG (lossless) with `R,G` = elevation as `uint16` in **0.25 m steps with a 10 m offset**, `B` = class (reserved), `A` = 255. **Decode with plain code, never through a canvas** (`png.ts`, using `DecompressionStream`): Brave (and likely Firefox/Safari privacy modes) add random ±1 noise to canvas reads, which on the high byte is a 64 m error (found in S1). A second tile set with the **bare-ground height (DTM)** on the same grid is published for the terrace observer height (§6.3; 1.9 MB for 3×3 km, ≈ 7 KB per tile). Published as **plain `z/x/y` files** (no range requests needed). **Measured in S1 and S4:** 35 KB per tile on average (65 KB max); **all of Brussels = 4,931 DSM tiles (177 MB) + 4,931 DTM tiles (48 MB) = 9,862 files**, about half of the free host's 20,000-file limit (≤25 MiB per file), so only one version is published at a time. Built in 2 min on an M3 or 7 min on a free GitHub runner, from 4.5 GB of source zips ([result](spikes/S4-pipeline-hosting.md)). z18 (≈17,000 tiles) is not needed: z17 shadows agree with the real photo (§6.2), so z16–z17 is the choice.
4. Build a **3D building layer** from the footprints with `height` = 90th percentile of nDSM inside each footprint (resists antennas/spikes), stored as plain `z/x/y` vector tiles (`.pbf`) for MapLibre `fill-extrusion`.

Known limitations (surfaced in the UI as "Data: 2021"): buildings built or demolished since 2021 are wrong; the monthly UrbIS *3D Constructions* (LoD2, CC0 ✓, absolute Z, SHP/GPKG) can patch this later. Datum shift Lambert-72 → WGS84 uses a Helmert transformation (the Belgian grid isn't in the pip wheels); the candidates differ by ≤0.3 m, under one pixel.

### 6.2 (a) Real-time shadow overlay for any date/time
**Spike S1 result: GO**, see [S1-shadow-renderer.md](spikes/S1-shadow-renderer.md). Prototype in `spikes/s1-shadow/`.
- A MapLibre **custom layer** (WebGL2). The height tiles are stitched into a `uint16` texture with a **max-reduced mip chain** (each level = max over 2ⁿ×2ⁿ pixels).
- A fragment shader does an **exact hierarchical traversal** toward the sun (direction from `suncalc`): it skips whole empty cells using the max-mips and descends to full resolution only near occluders. Ray-march bias is a **0.5 m tolerance that fades to zero over 6 m** (a global bias shortens real shadows; no bias fills flat ground with LiDAR-noise dashes). **Measured:** 17.25 m for the 10 m wall at 30° (analytic 17.32 m); max error 0.15 m over 96 sun positions; on real ground pixels it agrees with the 2024 aerial photo on **82.8 %** at the photo's flight time, falling to 71–76 % one hour away.
- **Native-resolution mask + smoothing (built in S1):** the shadow is ray-traced into an offscreen 0/1 mask at the data's own resolution for the visible window only, cached until the sun or view changes, blurred 3×3, then composited with bilinear filtering and a soft threshold centred on 0.5 (the exact edge; a higher centre shortens shadows). This removes hatching, speckle and stair-steps at no extra cost (2.7–4.1 ms per frame while scrubbing, M3). Always sample at **pixel centres**.
- **Sliding window:** the client holds a window of tiles (e.g. 16×16 = 3 km), re-uploaded as the user pans, with a margin around the viewport. Shadow length is capped at ≈500 m (a 100 m tower at 3° altitude would cast ≈1.9 km); the cap is documented in the UI.
- **Tilted maps / 3D buildings:** keep the shadow layer *below* the basemap's extruded buildings and draw them **opaque** (Liberty's default 0.8 opacity lets the ground shadow ghost through roofs and walls). Roofs/walls then get no shadow; rooftop terraces need shadow draped at roof height, later.
- No-data pixels are transparent and never occlude. Output: translucent shadow overlay; vegetation pixels use the seasonal transmittance (§6.4) so tree shade is lighter in winter.
- Scrubbing time only changes a uniform — no data reload.
- **Phone result:** Pixel 8 (Chrome) holds **60 fps** (mean 16.6 ms, p95 19.9 ms, worst 23 ms; 1079×1995 canvas, sun changing every frame). Laptop GPU timer figures overstate the cost (≈ 0.8 ms per pass at full clocks, ≈ 20× headroom on an M3). **Headroom measured with `&stress=N`:** one shadow pass costs ≈ 2.4 ms on the Pixel 8 (≈ 8 ms for the rest of the frame), so it can afford ≈ 3–4 passes per frame, ≈ 3× slower per pass than the M3. A phone 3× slower than the Pixel 8 would fall to ≈ 30 fps while scrubbing; plan **progressive quality** (coarser mask while the slider moves, full resolution when idle; 30 Hz cap). **Still untested:** iOS Safari, low-end Android.
- **Fallback (only if the phone test fails):** footprint-extrusion shadows only (reference: an MIT-licensed MapLibre building-shadow layer exists ✓, but covers buildings only, no trees).

### 6.3 (b) Per-place sun windows: horizon profiles, precomputed
**Spike S2 result: GO**, see [S2-horizon-profiles.md](spikes/S2-horizon-profiles.md). Code in `spikes/s2-horizon/` (plain TypeScript, no canvas/DOM).

Shadows are *not* recomputed per date for ranking. Instead, for each sample point we precompute the **horizon elevation angle per azimuth direction** from the height data:
- **144 directions × 1 byte (0.5° steps)**, rays up to **500 m**, step 0.5 px growing 2 % per step, early exit once nothing left in the scene can be steeper. **154 µs per point** (Node, M3). One profile per point; the vegetation profile (`h_all`) is added in M4 with the surface-class channel.
- **Observer height: 1.0 m above bare ground (DTM).** This needs the **ground-height tile set** (`build_tiles.py --kind dtm`, 1.9 MB for 3×3 km). **Covered points** (surface > 2.5 m above ground at the point: canopy, awning, roof) never see the sun. Rooftop terraces take the eye elevation from the surface instead (`eyeFrom: 'dsm'`; not evaluated separately).
- **Terraces: 3×3 sample points** ⇒ 1,296 bytes raw, **≈ 0.73 KB with brotli**; 5,000 terraces ≈ 3.6 MB compressed. Parks and squares sample a grid over the polygon.
- At query time, for any date: sun azimuth/altitude (`suncalc`) per minute → a point is lit if `altitude > horizon(azimuth)` (**linear interpolation** between directions). Vegetation-only blockage will count as `τ(date)` of a lit point (M4).
- Runs **entirely client-side in a Web Worker** over the few hundred places in the radius: 300 terraces × 16 points for a whole summer day at 1-minute resolution takes 73 ms on a laptop (5,000 terraces: 1.3 s); phones 3–6× slower, and the ranking only needs the next few hours.
- Terrace edited ⇒ horizon recomputed. The editor computes a **preview in the browser** with the same code; the authoritative values come from the pipeline job (§8).

**Measured accuracy** (vs an exact ray test on the same data; 3,000 points, 4 days, 1.75 M tests): 0.76 % of point-minutes wrong (median 5, 95th percentile 20 minutes per day). At terrace level (300 terraces, window edges at 1-minute resolution, truth = exact on 64 points): **median edge error 2 min, 95th percentile 12–17 min**. Against the S1 GPU renderer with the same near-field rule: **0.93 % disagreement** (1.40 % with the renderer's own noise filter). These compare the method with the same 2021 elevation data; real-world accuracy needs time-stamped ground truth (§12).

### 6.4 Seasonal trees
`τ(date)` = fraction of sunlight passing through vegetation pixels: low in leaf-on season (≈0.1–0.2), higher in leaf-off (≈0.5–0.7 for deciduous), linear ramps in spring/autumn (≈ mid-April→mid-May, mid-Oct→mid-Nov). **Values are assumptions to calibrate** with photos/ground truth. Evergreen trees are treated as deciduous in v1; species data (Bruxelles Environnement `tree` WFS has species ✓, 50,612 managed trees) can flag evergreens later.

### 6.5 Time handling
Store UTC instants; display with the venue's IANA time zone (`Europe/Brussels`) via `Intl`. The scrubber works in local time and handles DST days. Sun is treated as a point source; penumbra is ignored.

## 7. Data sources (catalogue)

| Need | Source | Licence | Access / notes |
|---|---|---|---|
| Heights, trees (all) | UrbIS **DSM 2021** `8c2d921e-6a53-11ed-bfb5-010101010000` + **DTM** `1d7bd49d-fe83-4388-af85-6f5dc8ec7909` ✓ | CC0 | Zipped GeoTIFF tiles via Atom feed `https://urbisdownload.datastore.brussels/atomfeed/<uuid>-en.xml` (217 DSM tiles ≈13 MB each). 2000×2000 px @ 0.5 m, float32, EPSG:31370. No WMS/WCS for the DSM. |
| Building footprints | UrbIS Buildings WFS `https://geoservices-vector.irisnet.be/geoserver/urbisvector/wfs`, layer `urbisvector:Buildings` ✓ | CC0 (parcels differ) | GeoJSON output, CORS `*`; no heights |
| Building updates (later) | UrbIS 3D Constructions `e9ec2aa4-cffd-11ee-bccc-00090ffe0001` ✓ | CC0 | Monthly, LoD2, SHP/GPKG; height from Z |
| Vegetation classes | Bruxelles Environnement *Vegetation* raster 2021/2023 ✓ | CC-BY | `https://app.bruxellesenvironnement.be/carto/vegetation.zip` (11 MB, 2 m) |
| Aerial view (editor only) | UrbIS Ortho **2024**, 5 cm ✓ | CC0 | WMTS `https://geoservices-grid.irisnet.be/geowebcache/service/wmts`, layer `Ortho`, set `EPSG:900913`; CORS `*`. Variants `Ortho2024NS` / `Ortho2024EO` (two flight axes) help when a facade hides a terrace. WMS fallback on `geoservices-urbis.irisnet.be/geoserver/urbisgrid/wms`. No published quota **[?]** |
| Venues | OSM (Overpass/extract): 3,330 cafés/bars/pubs/restaurants ✓, **757 with `outdoor_seating=yes`**, 156 `=no`, ≈2,400 untagged ✓ | ODbL | Points only, not polygons |
| Parks / gardens | Bruxelles Environnement `public_green_spaces` (1,305 polygons ✓, CC-BY) + OSM `leisure=park/garden` | CC-BY / ODbL | WFS `https://ows.environnement.brussels/green` |
| Squares / quays / benches | OSM `place=square` (152 ✓), pedestrian areas (344 ✓), `amenity=bench` etc. | ODbL | |
| Terraces (polygons) | **None open** ✓ (checked 206 opendata.brussels.be datasets + regional catalogue). Commune portals not checked and not pursued | — | See §9 |
| Photos | Panoramax `GET https://api.panoramax.xyz/api/search?place_position=lon,lat&place_distance=0-30&limit=N` ✓ | CC-BY-SA-4.0 per image | 4 of 7 central test spots had an image ≤30 m, all 7 ≤100 m ✓; show producer attribution; pick the image whose azimuth faces the venue |
| Basemap | OpenFreeMap (free, no key) | ODbL attribution | Fallback extract z0–14 Brussels ≈10.6 MB ✓ (z0–15 ≈29 MB exceeds the 25 MiB file limit) |
| Geocoding | Photon `photon.komoot.io` (typeahead, CORS `*`) ✓ | ODbL | Fair use, no SLA, no self-hosting. Brussels geocoder `https://geoservices.irisnet.be/geocoding/api/v2/brussels/...` works ✓, limits/licence **[?]** — free fallback / precision upgrade |

Attribution: OSM contributors, Paradigm/UrbIS, Bruxelles Environnement (CC-BY), Panoramax authors, OpenFreeMap/OpenMapTiles. A single "Credits" page + in-map attribution.

Later regions (verified existence only): Flanders DHMV II 1 m DSM + Geopunt ortho + GRB WFS; Wallonia MNS 0.5 m (CC-BY 4.0) and ready-made MNH; licence wording to check **[?]**.

## 8. Architecture

```
                 ┌── build jobs (Python; your Mac / free GitHub Actions) ─────────────┐
 UrbIS DSM/DTM ─▶│ mosaic → classify → height tiles ──────────▶ static host: height/{z}/{x}/{y}.png
 UrbIS footprints▶│ footprint heights ────────────────────────▶ static host: buildings/{z}/{x}/{y}.pbf
 OSM / parks ───▶│ import places → seed terraces → horizon profiles ▶ Postgres (PostGIS)│
                 │ export snapshot ───────────────────────────▶ static host: places/{z}/{x}/{y}.json
                 └────────────────────────────────────────────────────────────────────┘
 Browser (PWA):  MapLibre + shadow layer  ◀── static host (Cloudflare Pages, free)
                 Web Worker: sun windows + ranking (packages/sun)
                 Supabase: auth, favourites, terrace edits, claims  ◀─▶ Postgres/RLS
                 Photon / Panoramax / OpenFreeMap fetched directly (CORS)
```

- **Reads are static.** Place snapshots (geometry, tags, horizon profiles) are chunked per tile and published on the static host so map browsing never hits Supabase (5 GB egress on free ✓ would be exhausted otherwise). The client merges a small "changes since snapshot" call to Supabase.
- **Writes** go to Supabase (RLS-protected). Approved edits trigger a recompute job (run by you or a free GitHub Actions workflow; decided in S4) and a snapshot rebuild/redeploy (Cloudflare Pages: the 500/month limit applies to Git builds; Direct Upload has no documented monthly cap and an incremental deploy of 1 changed file in 10,000 takes 15 s, so rebuilds are batched, e.g. nightly, for cleanliness rather than for the limit).
- **No server compute at request time**, so Vercel stays on static + a few route handlers (OG share images, sitemap).
- **Privacy:** the user's position stays in the browser. No third-party trackers; analytics, if any, cookie-less.

### 8.1 Repository layout
```
apps/web/            Next.js PWA (UI, map, editor, i18n)
packages/sun/        pure TS: sun position wrapper, horizon sampling, window finder,
                     ranking, config — runs in browser worker and Node (heavily tested)
packages/pipeline/   (Python) data import, classification, tiles, horizon profiles, exports
packages/db/         SQL migrations, RLS policies, seed data
docs/                this spec, ADRs
```

### 8.2 Data model (PostGIS, sketch)
- `places`: id, kind (`bar|cafe|restaurant|pub|park|garden|square|quay|bench|rooftop|other`), name, osm_ref, location `geography(Point)`, area geometry (parks/squares), opening_hours, tags jsonb, source, updated_at.
- `terraces`: id, place_id, geom `geometry(Polygon,4326)`, status (`seeded|community|verified|owner`), mode (`ground|rooftop`), current_revision_id, horizon_version, computed_at.
- `terrace_revisions`: id, terrace_id, author_id, geom, comment, state (`pending|approved|rejected|reverted`), reviewed_by, created_at. **Full history, revertible.**
- `horizon_profiles`: terrace_id, dsm_version, params, data bytea (3×3 points × 144 bytes; also exported to snapshots).
- `profiles`, `favorites`, `reports`, `venue_claims` (stub), `attribute_votes` (dog/kids/heating/wheelchair, later).
- RLS: users read/write their own favourites; any authenticated user inserts revisions; only the moderator role (the product owner) approves; trusted authors auto-approve after N approved edits so the queue stays small for one person.
- Edit sanity checks (server-side): polygon within ~60 m of its place, area 2–500 m², valid geometry, not mostly inside a building footprint unless `mode=rooftop`, rate limited.

## 9. Terrace positions (the hard data problem)

No open terrace data exists ✓, and only ~23% of OSM venues are tagged `outdoor_seating=yes` ✓. So terrace *existence* and *geometry* both need work:

1. **Existence status:** `confirmed` (OSM yes or community), `unlikely` (OSM no), `unknown` (~72%). Unknown venues appear lower in results with "Terrace not confirmed".
2. **Auto-seeding (method A, chosen in S3):** place a default rectangle in front of the venue: snap the OSM point to the nearest building-footprint edge, offset outward onto the free (non-building) side, **12 × 6 m** (measured on 42 reference terraces: median ≈ 14 × 6.4 m, area median 64 m², 10th–90th percentile 24–199 m²; the first guess of 4 × 2 m was far too small; scale by venue type later). Marked `seeded`. The OSM point alone must not be used for the sun test: it lies inside the building (76 % of sun-minutes right vs 89 % for the rectangle). Large squares and pedestrian-zone venues need a person.
3. **Commune permit data: not pursued** (decision: no requests to the communes). If a commune ever publishes terrace geometry as open data, it can be imported as `community`-grade seeds; nothing in the design depends on it.
4. **Bootstrap review before launch:** the moderator (with friends, if wanted) verifies the ~200 most visited terraces (Flagey, Sablon, Saint-Géry, Châtelain, Parvis de Saint-Gilles…) on the aerial view so the first impression is accurate. Those become `verified`.
5. **Imagery-assisted detection (aerial photos, not satellite).** Yes: the terrace position can be proposed and snapped from the imagery. It uses the **UrbIS 5 cm aerial photos** (tables, chairs and parasols are visible; satellites are typically ≥30 cm and far less precise). Only small crops (≈40 m around each venue, ~3,300 venues) are analysed, never the whole city, so it is cheap. Candidate methods, compared in spike S3:
   - **A. Heuristic seeding** (item 2): free pavement in front of the facade. No imagery needed. **Chosen for M2.**
   - **B. Imagery classifier**, trained **locally on your Mac (free)** on the polygons that humans draw in the editor and in the bootstrap review. The S3 prototype is a per-pixel gradient-boosted classifier (scikit-learn) on colour, texture, building distance and height-above-ground features; a deep object detector was not needed to test the idea (if one is tried later, use permissively licensed tooling such as torchvision/MMDetection rather than AGPL-licensed Ultralytics YOLO **[?]**). **S3 result: no better than A for sun purposes** (89.8 % vs 89.2 % of sun-minutes right; overlap IoU 0.30 vs 0.28; both ≈ 3 m off), but it keeps improving with labels (IoU 0.21 with 8 training venues → 0.30 with 54, not yet levelled off) and it gives a useful *existence* hint (AUC 0.81). Not shipped in M2; used as a hint in the editor and in the moderator's review queue, and retrained once a few hundred verified polygons exist. The editor therefore doubles as a labelling tool.
   - **C. (Dropped.)** Multimodal LLM proposals would cost money per call, which the zero-cost rule forbids.
   - **Extra signals:** a terrace seen in several yearly aerial photos (Ortho 2021–2024 layers exist ✓) is more likely permanent; a Panoramax street-level photo can confirm tables on the pavement.

   **Existence is separate from position.** OSM `outdoor_seating` is a hint, not a fact: of 70 venues tagged yes/sidewalk/pedestrian_zone, 42 had a terrace (69 % of decided venues), and 2 of 4 tagged `no` did. Not seeing tables on the photo is weak evidence of no terrace (a reviewer found 21 terraces that a photo-only first pass had rejected: shade, awnings, trees, other days). Show "Terrace not confirmed" for untagged venues and let users add or remove terraces.

   Proposals are **never auto-confirmed**: they enter as `seeded`, and a human confirm/edit promotes them. Blurring the footprint to express position uncertainty gives no gain (89.7 % vs 89.2 %), so uncertainty is shown in the UI instead. Known limits: parasols and awnings hide tables; facades "lean" in non-true orthophotos (hence the NS/EO variants); the photo is a snapshot (Sept 2024) and shows what was set out that day; neighbouring venues share the same pavement, so assigning tables to the right venue is ambiguous and needs the venue point + a human check; rooftop terraces need extra care.
6. **Community editor** (F6): draw/drag/edit on the 5 cm aerial view with the live shadow preview; pick `ground` or `rooftop`; history; moderation queue; contributor attribution (leaderboard later).
7. **Parks/squares:** use official polygons; sample the whole polygon (grid), so "sunny part of the park" can be shown later.

## 10. Idea backlog (beyond v1)
- **Weather sun score** (Open-Meteo `cloud_cover`, `direct_radiation` ✓): one cached call per hour covers Brussels. The free API is **non-commercial** but allows donations ✓; with no ads or subscriptions it stays free. The ranking formula already has a place for a weather multiplier.
- Notifications: "Your favourite terrace gets sun in 20 min", daily morning digest.
- Sundowner mode: open western horizon (horizon profiles give this for free).
- Per-table heatmap inside a terrace.
- "Still sunny here?" check-ins as ground truth for accuracy.
- Sun-chasing route through the afternoon; "Meet at…" calendar invites.
- Owner dashboard (claim, heated/dog/wheelchair attributes, "sun hours" badge).
- Open API for the terraces dataset.

## 11. Delivery plan

**M0 — Spikes (de-risk first).** Each has a written outcome.
- **S1 Shadow renderer — ✅ GO** ([result](spikes/S1-shadow-renderer.md)): DSM height atlas + exact hierarchical ray traversal in a MapLibre custom layer. Wall test 17.25 m vs 17.32 m; max error 0.15 m over 96 sun positions; 82.8 % ground-pixel agreement with the real 2024 aerial photo; 60 fps on a Pixel 8 (Chrome; ≈ 2.4 ms per shadow pass, ≈ 3–4 passes of headroom); ≈ 0.8 ms per pass on an M3. **Untested:** iOS Safari and low-end Android; progressive quality planned for M1.
- **S2 Horizon profiles — ✅ GO** ([result](spikes/S2-horizon-profiles.md)): 144 directions × 1 byte, linear interpolation; terraces use 3×3 points; 0.76 % of point-minutes wrong vs the exact test, terrace window edges median 2 min / 95th percentile 12–17 min; 0.93 % disagreement with the GPU renderer under the same rule; 154 µs per point to compute, 73 ms to evaluate 300 terraces for a day; ≈ 0.73 KB per terrace compressed.
- **S3 Terrace positions from imagery — ✅ GO, smaller promise** ([result](spikes/S3-terrace-positions.md)): 74 venues reviewed on the 5 cm photo (44 terraces; the reference was drawn by me and corrected by you). Automatic positions (A facade rectangle, B imagery classifier) are ≈ 3 m off: IoU 0.28 / 0.30 vs 0.68 between two people; 89 % of sun-minutes labelled right vs 96 % after human correction (OSM point alone: 76 %). A seeds M2 (12 × 6 m); B is a hint, not shipped. OSM seating tags are right for 69 % of decided venues. **Untested:** real-world sun ground truth (dated photos), untagged venues, year-round days.
- **S4 Pipeline ops & free hosting — ✅ GO** ([result](spikes/S4-pipeline-hosting.md)): all of Brussels = 4,931 + 4,931 tiles (225 MB, 9,862 files) plus a 204-file, 2.8 MB place snapshot (863 B per terrace); tiles build in 2 min on an M3 / 7 min on a free GitHub runner (11 min incl. the 4.5 GB download); the frequent seed + horizons job takes ≈ 5 min on a free runner. Cloudflare Pages tested for real: 25 MiB and 20,000 files are hard limits, CORS/immutable caching/ETag/brotli work, 15 s incremental deploys; **no range requests**, **missing tile = 200 + HTML without a `404.html`**, header rules add up. Overpass failed once from a runner (retry across instances). **Not tested:** CI deploy to Pages (needs an API token), phones on 4G, a Supabase keep-alive.
- **S5 Photos:** Panoramax picking by azimuth; attribution UI.

**M1 — Shadows on Brussels.** Basemap, 3D buildings, shadow layer, scrubber/date picker, geolocation, address search, PWA shell, i18n scaffolding (5 locales). *Done when* a user can scrub shadows on their phone anywhere in Brussels.

**M2 — "Sun now".** Place import, terraces seeded with method A (12 × 6 m on the free side of the nearest facade), horizon profiles, `packages/sun` ranking, cards with sun windows (approximate wording for `seeded`), opening hours, walk/bike, place detail with photo.

**M3 — Community.** Auth, terrace editor on the aerial view, revisions + a simple moderation queue (one moderator), bootstrap review of the ~200 top terraces (start from the S3 review tool, `spikes/s3-terraces/review.html`, which already does vertex editing, status, notes and Street View links; the 74 reviewed venues are the first labelled data), favourites, share links (+OG image), filters.

**M4 — Seasons, shade, open data.** Seasonal trees, shade mode, translations reviewed, snapshot export as open dataset, OSM contribution flow, "Credits".

**M5 — Launch hardening.** Performance budget, offline cache, error monitoring, privacy page, SEO landing pages ("sunny terraces in Brussels"), keep-alive cron + backup export for Supabase (free GitHub Actions), add the optional donation link (after the hosting decision in §13).

## 12. Testing & accuracy

- `packages/sun`: unit tests against reference sun positions (NOAA calculator values for several dates/latitudes), window-finder edge cases (DST, midnight crossings, merged gaps), ranking golden tests.
- Synthetic worlds: flat plane + walls/boxes of known height → analytic shadow lengths; the renderer and horizon method must agree within tolerance.
- Real-world checks: a set of ~30 venues with photos/known sun times at various dates; record error in minutes. Method error is already known (S2: median 2 min, 95th percentile 12–17 min vs the exact test on the same data); what remains is **real-world error**, which needs dated photos of terraces in sun/shade (the aerial photo gives one time; see also the "still sunny here?" check-ins in the backlog). Target: median |error| ≤ 15 min on window edges.
- Playwright smoke tests on a mobile viewport: locate → suggestions → open place → edit terrace.
- Accuracy disclosures in the UI: data year, "orientation only: awnings, parasols and temporary structures aren't modelled".

## 13. Legal / licensing notes
- Combined venue database derives from OSM (ODbL) ⇒ publish the open dataset under **ODbL**; contributors accept terms compatible with that (and with giving polygons back to OSM). Needs a quick legal read **[?]**.
- Panoramax images are CC-BY-SA-4.0: display with producer attribution; check share-alike obligations for derived screenshots/OG images **[?]**.
- **Donation link ("buy me a coffee").** Not monetisation in the usual sense (no ads, no paid features), but whether it is "commercial" depends on each provider:
  - **Open-Meteo** (weather, later): its terms say donations are allowed on the free tier; ads and subscriptions are not ✓ (https://open-meteo.com/en/terms).
  - **Vercel Hobby:** the terms say "personal or non-commercial use" and I found **no definition** of commercial, nor any mention of donations ✓ (https://vercel.com/legal/terms, §4). A coffee link is a grey area; Vercel may remove Hobby deployments without notice. Since paying is ruled out, the options are: accept the small risk, or host the app on Cloudflare Pages/Workers instead (free; S4 read the Developer Platform service terms: no commercial-use or donation clause, only a soft "undue burden" limit; the general Self-Serve Subscription Agreement was not read in full **[?]**). Using Pages for the data already (S4) makes this the natural option. Decide before M5.
  - Keep it a plain external link (Ko-fi / Buy Me a Coffee / GitHub Sponsors), with no feature gating and no ads, to stay as close to "non-commercial" as possible.
  - Money received may have tax/declaration consequences in Belgium **[?]**; check locally.
- GDPR: no accounts required to use the app; position processed on-device; contributions linked to a pseudonymous display name.

## 14. Open questions & risks

| # | Item | Impact | Mitigation |
|---|---|---|---|
| R13 | Browsers that alter canvas/WebGL reads (Brave farbling, others) | Wrong elevations ⇒ streak artifacts | **Rule: never decode or read data back through a canvas/`readPixels`** (decode PNG in code, upload straight to textures); applies to the horizon-profile code in the browser too; add a start-up self-check if a canvas path ever returns |
| R1 | Shadow shader performance on phones | Core UX | S1 done: exact traversal is 3.5–6× faster than the first version and accurate; native-resolution mask + smoothing built; **Pixel 8 holds 60 fps with ≈ 3–4× headroom**; progressive quality planned; iOS Safari and low-end Android untested; `?pr=1` and the footprint-shadow fallback as mitigations |
| R2 | Terrace existence/geometry data is thin (~72% venues untagged; tags right for only 69 % of tagged venues), and no commune permit data | Ranking quality at launch | Seed with method A (≈ 3 m, ~89 % of sun-minutes right, S3) shown as "estimated" + bootstrap review of top ~200 terraces (≈ 1 m, ~96 %) + community edits; confidence badges |
| R3 | DSM is from 2021 (new/demolished buildings wrong) | Wrong shadows locally | Show data year; patch with UrbIS 3D Constructions; "report error" |
| R4 | Tree seasonality parameters are assumptions; evergreens unknown | Tree-shade error | Calibrate on photos; species data later |
| R5 | Filter attributes (dog, kids, heating, wheelchair) are sparsely tagged in OSM | Filters feel empty | Show "unknown"; community votes later |
| R6 | Moderation workload (one moderator) / vandalism | Data quality, your time | Revisions, sanity checks, trusted-author auto-approval, rate limits, reversible history |
| R7 | Free tiers: Supabase pausing, Photon fair-use, OpenFreeMap no SLA, Cloudflare Pages file limit (20,000; we use ~10,100) | Outages or throttling | Two keep-alive pingers (GitHub cron is disabled after 60 idle days in public repos; add a free Cloudflare Worker cron), client-side caching, one tile version at a time, size budgets (§6.1), retries across Overpass instances; no self-hosting fallbacks that cost money. Accept occasional downtime |
| R8 | Routing: straight-line × 1.3 is a guess | Wrong travel times | Calibrate against a few real walks; free public OSRM for the selected venue only, later |
| R11 | Login: Supabase's free email sender is 2/hour | Sign-in friction | Google sign-in first; magic link only with a free custom SMTP |
| R12 | Free-tier growth ceiling (Vercel 100 GB/month, Supabase 5 GB egress) | The app throttles if it becomes popular | Static-first design keeps Supabase traffic tiny; if it outgrows free tiers, the app degrades instead of billing |
| R9 | Panoramax rate limits and coverage **[?]** | Missing photos | Cache image URLs; graceful empty state |
| R14 | Terraces near 50 % lit for long stretches flip between "all day" and "with a gap" (≈1 % of terrace-days) | Confusing windows | Hysteresis (on 50 %, off 35 %), lit-share timeline + "partly sunny" state, rank by expected sunny area (S2) |
| R10 | Licence/ToS items marked **[?]** | Legal | Resolve before M5 |

**Decided:** name = Vitamine D · moderator = the product owner · no monetisation planned · no requests to the communes · **nothing that costs money**.
**Still open (non-blocking):** open-dataset licence (ODbL recommended) · donation link yes/no and where to host the app (§13)  · (the free static host was confirmed in S4).
