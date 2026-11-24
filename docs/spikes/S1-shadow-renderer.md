# Spike S1 — Shadow renderer: result

**Verdict: GO.** Live shadows from the Brussels LiDAR surface model work, are accurate against reality, and hold 60 fps on a Pixel 8 (Chrome). Not yet tested: iOS Safari and low-end Android, and the phone's headroom (see [Open](#open)).

Code: [spikes/s1-shadow/](../../spikes/s1-shadow/) · Spec: [SPEC.md §6](../SPEC.md)

## What was built

| Piece | What it does |
|---|---|
| `fetch_tiles.py` | Downloads the UrbIS DSM + DTM GeoTIFF tiles (1 km, 0.5 m, EPSG:31370) around a tile code |
| `build_tiles.py` | Mosaics 3×3 km, reprojects to web-mercator **z17** (≈0.75 m/px at Brussels), writes 256 PNG height tiles |
| `web/src/atlas.ts` | Stitches the tiles into one 4096² `uint16` atlas and builds a **max-reduced mip chain** |
| `web/src/shadowProgram.ts` | WebGL2 fragment shader: exact ray traversal toward the sun through the max-mips |
| `web/src/shadowLayer.ts` | MapLibre custom layer that paints the shadows on the map |
| `web/test.html` | Synthetic test: a box of known height, analytic shadow length |
| `web/validate.html` | Compares the predicted shadows with the real shadows in the 2024 aerial photo |
| `web/index.html` | The demo: date/time scrubber, aerial toggle, benchmark button |

## Results against the acceptance criteria

| Criterion | Result |
|---|---|
| 10 m wall, sun 30° ⇒ shadow 17.3 m ±0.5 m | **17.25 m** (analytic 17.32 m) |
| Accuracy over many sun positions | 6 altitudes × 16 azimuths (including near-cardinal): **max error 0.15 m, mean −0.01 m** (tested at 0.25 m/px) |
| Matches real shadows | At the aerial photo's flight time, **82.8 %** of ground-level pixels agree (shadow IoU 0.76), see below |
| ≥ 50 fps on a mid-range phone at z16–17 | **Pixel 8, Chrome, 1079×1995 canvas, z17, summer afternoon: mean 16.6 ms (60 fps), p95 19.9 ms, worst 23 ms** over 300 frames with the sun changing every frame. 60 fps is the display cap; the stress runs below give the headroom. GPU timing is unavailable in Chrome on Android ("n/a") |
| Data fits the free static host | **33 KB per tile** on average, 8.6 MB for the 3×3 km test area ⇒ roughly 150 MB for all of Brussels (extrapolated), ≈4,300 files at z17: within 25 MiB/file and 20,000 files |

### Accuracy against reality (2024 aerial photo)
The UrbIS aerial photo (flown 20 Sept 2024) contains real shadows. For every 10 minutes of that day I rendered the predicted shadows and compared them with the photo.

- The agreement has one sharp peak at **10:30 UTC (12:30 local), sun azimuth 159°, altitude 38°**. All 16 regions of the 3×3 km area peak independently between 10:10 and 10:40 UTC, so the photo has a single flight time and the model's shadow *direction and length* are right everywhere.
- Correlation between photo brightness and predicted shadow: **−0.585** at the peak against −0.32 as the typical value over the day.
- On **310,910 ground-level pixels** (streets, squares, courtyards: where terraces are), my sun-or-shade call agrees with the photo on:

| Time offset from the true flight time | Agreement |
|---|---|
| **0** | **82.8 %** (shadow IoU 0.757) |
| −1 h / +1 h | 75.9 % / 71.5 % |
| −3 h / +3 h | 67.1 % / 55.5 % |

Predicted shadow 59 % of ground pixels vs 67 % observed.

**Caveats.** The "observed shadow" is a brightness threshold on the photo (Otsu = 130), which mislabels dark paving and cars. The surface model is from 2021 and the photo from 2024 (buildings built or demolished since). Tree canopy is treated as opaque. So 82.8 % is a rough lower-confidence number, not a precise accuracy figure; the peak shape and its consistency are the stronger evidence. Real checks on ~30 venues come in spike S2.

### Performance (M3 Mac, Chrome, GPU timer queries)

| Variant | Canvas | Shadow pass |
|---|---|---|
| First version: fixed steps + mip levels | 2048×1536 (3.1 MP, ≈ a phone screen) | 17.1–17.8 ms |
| **Final: exact hierarchical traversal** | 2048×1536 | **2.8–5.0 ms** |
| Final | 1024×768 (0.8 MP) | 2.8–4.5 ms |
| Final | 512×384 (0.2 MP) | 0.8–1.8 ms |
| **With mask + smoothing** (sun changing every frame) | 2048×1536, z16 / z18 | **4.1 ms / 2.7 ms** (direct: 4.4 / 3.6 ms) |

Load: 256 tiles fetched in ≈160–490 ms (local), decoded in ≈40 ms, mips built in ≈18 ms. The cost is almost independent of sun height. It does **not** scale cleanly with pixel count (3.1 MP and 0.8 MP take about the same, 0.2 MP is clearly cheaper); GPU clock scaling on the laptop at light load is a likely factor, so extrapolating these numbers to a phone GPU is uncertain.

**The timer figures are pessimistic upper bounds.** A stress test (`&stress=N` repeats the shadow pass N times per frame) on the M3 shows why: the GPU timer reported 3.7 ms for one pass, yet with 16 passes per frame the app still held 60 fps (timer: 34 ms), and with 64 passes a frame took 50 ms (20 fps) ⇒ **about 0.8 ms per pass at full GPU clocks**, i.e. roughly 20× headroom over a 16.7 ms frame. At light load the GPU simply runs at a lower clock. **Pixel 8 stress runs** (Chrome, 1079×1995 canvas, mask 640×768, sun changing every frame):

| Shadow passes per frame | Mean frame | p95 | Worst |
|---|---|---|---|
| ×1 | 16.6 ms (60 fps) | 19.9 ms | 23 ms |
| ×4 | 17.7 ms (57 fps) | 24.6 ms | 83 ms |
| ×16 | 43.9 ms (23 fps) | 129.5 ms | 203 ms |
| ×32 | 86.2 ms (12 fps) | 164.9 ms | 246 ms |

Slope ≈ **2.4 ms per extra pass** (2.2 between ×4 and ×16, 2.6 between ×16 and ×32); the rest of the frame (basemap, compositing, JS) ≈ 8 ms. So the phone can afford about **3–4 passes per 16.7 ms frame**: about 3× slower per pass than the M3 (≈ 0.8 ms), and one pass leaves ≈ 6 ms spare. To measure another device: Benchmark with `&stress=4`, `16`, `32` and fit the slope.

## Decisions and findings (feed the spec)

1. **Exact hierarchical max-mip traversal** replaces fixed-step marching: skip whole empty cells, descend only near occluders. 3.5–6× faster *and* more accurate (max error 0.15 m vs 0.63 m).
2. **Ray-march bias: a small tolerance that fades out with distance.** A *global* bias shortens real shadows (0.25 m ⇒ up to 1.55 m too short at 10° sun). But with bias 0, LiDAR noise (cobbles, 0.25 m quantisation) makes flat ground shade its neighbours and the plazas fill with 1-pixel dashes that move with the sun (found by you on the demo, confirmed on the Grand-Place). Fix: tolerance of 0.5 m at the start pixel, fading linearly to zero over 6 m. Wall shadows stay exact (max error still 0.15 m) and ground agreement with the photo is unchanged (82.8 %). This removed the ground speckle but not the stair-stepped edges and roof hatching: see decision 3.
3. **Native-resolution mask + smoothing (built, `shadowMask.ts`).** The shadow is ray-traced into an offscreen 0/1 mask at the data's own resolution (1 texel per data pixel, coarser only when zoomed far out) for the visible window plus a margin. The mask is cached until the sun, zoom or window changes, blurred with a 3×3 filter (a lone pixel drops to 0.25, a 1-pixel line to 0.5), then composited with bilinear filtering and a soft threshold **centred on 0.5**. Result: no hatching on roofs or façades, no speckle, smooth instead of stair-stepped edges. Tuning by measurement: a threshold centre of 0.575 looked a little cleaner but shortened shadows by up to 0.5 m at 10° sun; **0.5 keeps the exact edge** (max error still 0.15 m, same as unsmoothed). The cost is slightly rounded corners (≈ one data pixel, 0.75 m). Speed: **4.1 ms vs 4.4 ms (direct) per frame at z16 and 2.7 ms vs 3.6 ms at z18** while the sun changes every frame; panning or zooming with a fixed sun only re-composites. Tiny white streaks can remain where a façade is a ramp in the data.
4. **Sample at pixel centres.** My first validation sampled exactly on pixel corners and produced a fake 15-point jump in shadow area when the sun crossed azimuth 180°. A 1:1 mask render does not have this problem; a test now covers near-cardinal azimuths.
5. **No-data pixels (elevation value 0) are transparent**, and never occlude.
6. **A single 4096² atlas covers only 3 km.** For all of Brussels the client needs a **sliding window of tiles** (e.g. 16×16 or 8×8) re-uploaded as the user pans. The window needs a margin: low-sun shadows are long (a 100 m tower at 3° altitude casts ≈1.9 km), so shadow length is capped (≈500 m) and the cap is documented in the UI.
7. **Data format:** PNG, `R,G` = elevation as `uint16` in 0.25 m steps with a 10 m offset, `A` = 255, plain `z/x/y` files. Browser decoding must disable premultiplication and colour conversion (verified). `B` is reserved for the surface class (seasonal trees, M4); not built in S1.
8. **UrbIS GeoTIFFs have no embedded CRS.** Georeferencing is in a sidecar `.tfw` world file (0.5 m pixels, tile origin offset by a fraction of a metre). The tiles join exactly (checked).
9. **Datum shift is unverified to the centimetre.** PROJ offers three Helmert transformations for Lambert-72 → WGS84, differing by ≤ 0.3 m; the Belgian grid-based transformation is not available in the Python wheels. Under one pixel (0.75 m), and the aerial-photo agreement suggests no visible shift, but no direct measurement was done.
10. **Pipeline language: Python** (rasterio/GDAL 3.12, numpy, pyproj, Pillow via pip wheels). No system GDAL was needed. The spec said Node + GDAL CLI; Python is a better fit for raster work. The app and `packages/sun` stay TypeScript.
11. **MapLibre 6 specifics** (the newest major version): named exports, the web worker URL must be set explicitly under Vite, and `defaultProjectionData.mainMatrix` is float64 so the quad matrix can be composed in double precision before upload.
12. **Roof self-shadowing** flips en masse when the sun's azimuth crosses the direction of a roof pitch (many Brussels roofs share the same slope). That is physically right, irrelevant for ground terraces, but worth knowing for rooftop terraces.

13. **Tilted map: the basemap's 3D buildings are 80 % opaque, so the ground shadow ghosts through them.** With the map tilted, the ground-level shadow layer showed through the roofs (gray patches that copy the ground shadows) and faintly smeared up the walls. The shadow layer already sits *below* the buildings in the layer stack; the Liberty style draws `building-3d` at `fill-extrusion-opacity` 0.8, so 20 % of the overlay shows through. **Fix: draw the buildings opaque (`fill-extrusion-opacity` 1).** Tested in four combinations (2d/3d rendering mode × translucent/opaque buildings): only opacity matters; the rendering mode makes no difference. (An earlier version of this note blamed missing depth testing and switched the layer to MapLibre's `3d` mode; that was wrong and has been reverted.) Consequence: roofs and walls of extruded buildings receive no shadow; for rooftop terraces the shadow would need to be draped at roof height (future work).
14. **Ruled out: running out of ray-traversal steps.** At low sun, rays along street canyons can exhaust the 192-step budget (seen with a debug view). Measured over the whole 3×3 km area at 10 sun positions: ≤ 0.02 % of pixels differ from a 3000-step run, so it is not what causes visible lines. The budget is now a parameter (`maxIter`).

15. **Brave corrupts canvas reads: never decode data through a canvas.** The "lines that move with the shadows" seen in Brave (and not in Chrome) were this. Brave's fingerprinting protection ("farbling", on by default) adds random ±1 noise to canvas pixel reads (`getImageData`, and likewise `readPixels`/`toDataURL`). Measured on one tile in Brave 157: **228 of 65,536 pixels altered, each by ±1 in a colour channel; Chrome 0**. Elevation is stored as a high byte and a low byte, so a ±1 on the high byte is a **64 m error**: random ground pixels became 64 m towers, each casting a long thin shadow along the sun direction. The earlier bias and smoothing fixes could not hide that (and smoothing blurred the streaks, hence "smoothed lines"). **Fix:** `png.ts`, a ~90-line PNG decoder (inflate via the built-in `DecompressionStream`, then PNG unfiltering) that never touches a canvas. Verified bit-exact on the same tile in Brave and Chrome (0 wrong bytes of 262,144), and the full demo renders identically in both (`?decode=canvas` re-enables the old path to reproduce the bug). Cost: decode ≈ 0.2 s for the 256 tiles (≈ 3× the native decoder). **Project rule: elevation and any other data must be decoded in plain code (or uploaded straight to a texture), never read back from a canvas or WebGL.** The test pages (`test`, `validate`, `diff`) still use `readPixels` for their measurements, so run them in Chromium/Chrome. Other browsers with similar protections (Firefox's resistFingerprinting, Safari/Tor) are likely affected the same way, so the rule is general.

## Open
- **Weaker phones.** The Pixel 8 is upper mid-range. Its headroom was measured (see below): one shadow pass costs ≈ 2.4 ms and it can afford about 3–4 per 16.7 ms frame. A phone 3× slower would drop to roughly 30 fps while the sun is changing every frame. Planned mitigations (M1): **progressive quality**: while the time slider or play is moving, compute the mask at a 2× coarser texel (¼ of the pixels) and refine to full resolution when idle; cap recomputation at 30 Hz; `?pr=1`; the footprint-shadow fallback.
- **iOS Safari and low-end Android** (integer textures with `texelFetch` at mip levels, WebGL2) are expected to work but are untested.
- Benchmark how-to: open `http://<your-computer's-LAN-IP>:5173/?t=2026-06-21T14:00&z=17` on a phone on the same network, wait for the "atlas…" line, tap **Benchmark**, read the green line.
- **Tile streaming** (decision 6) is designed, not built. The window logic of the mask (`chooseWindow`) is the natural place to hook it in.
- Seasonal tree transparency (needs the surface-class channel), and real-venue checks (S2).

## How to run

```bash
cd spikes/s1-shadow
python3 -m venv .venv && .venv/bin/pip install numpy rasterio pyproj pillow
.venv/bin/python fetch_tiles.py 148170 1      # 3×3 km around the Grand-Place (~275 MB)
.venv/bin/python build_tiles.py                # writes web/public/tiles (8.6 MB)
cd web && npm install && npm run dev           # http://localhost:5173/
```

Pages: `/` demo (`?t=2026-06-21T17:00&z=17&pr=1`, `&pitch=60`, `&decode=canvas` for the old Brave-breaking path), `/test.html` synthetic accuracy test, `/validate.html` aerial-photo validation, `/diff.html` mask-difference debug view, `/browser-check.html` checks whether a browser alters canvas reads (compare its `offscreen` array with the PNG's true bytes).
