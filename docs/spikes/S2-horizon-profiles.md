# Spike S2 — Horizon profiles for sun windows: result

**Verdict: GO.** A precomputed "skyline" per terrace reproduces the exact sun test closely, is tiny, and is fast enough to rank hundreds of places in the browser. The numbers below compare the method with the same elevation data (2021 LiDAR); they say nothing yet about how close that data is to reality (S1 measured 82.8 % ground-pixel agreement with a real aerial photo).

Code: [spikes/s2-horizon/](../../spikes/s2-horizon/) (TypeScript, 7 unit tests) · [spikes/s1-shadow/web/s2-agreement.html](../../spikes/s1-shadow/web/s2-agreement.html) (GPU comparison) · Spec: [SPEC.md §6.3](../SPEC.md)

## The method in one paragraph
For each sample point we trace rays outward in 144 compass directions through the height data and keep, per direction, the elevation angle of the highest obstacle within 500 m: the **horizon**. Stored as one byte per direction. At any date and time, the point is lit if the sun's altitude is above the horizon at the sun's azimuth (linear interpolation between directions). A terrace's sunny share is the share of its sample points that are lit; windows are built from that.

## What was measured

All against an **exact reference**: a CPU ray test at the sun's exact azimuth with a fine step, on the same data. 3,000 random open-ground points (streets, squares, courtyards, parks) in the 3×3 km area; four days (21 Mar, 21 Jun, 21 Sep, 21 Dec); 583 sun positions at 5-minute steps = 1.75 M tests.

### Per point: how many compass directions?
| Directions | Bytes/point | Wrong % | Minutes/day wrong, median / 95th | µs to compute |
|---|---|---|---|---|
| 36 | 36 | 2.02 | 10 / 45 | 50 |
| 72 | 72 | 1.19 | 5 / 30 | 86 |
| **144** | **144** | **0.76** | **5 / 20** | **154** |
| 360 | 360 | 0.53 | 0 / 15 | 340 |
| 720 | 720 | 0.45 | 0 / 15 | 627 |

144 is the knee of the curve. Beyond it the remaining error (≈ 0.5 %) is thin objects narrower than the direction spacing and pixel noise, which more directions barely help.

### Smaller design choices
- **Interpolation between directions:** linear is best (0.76 % wrong); nearest 0.92 %; taking the max of the two neighbours (conservative) 1.27 %.
- **Pooling** (trace more directions and keep the highest within each bin): removes "falsely lit" errors but creates more "falsely shaded" ones, so the total gets worse (1.25 %). **Rejected.**
- **Storage precision:** float32 0.75 %, 0.35° bytes 0.76 %, **0.5° bytes 0.77 %**, 1° 0.82 %, 2° 1.01 %. **0.5° steps** (180 levels, one byte) lose nothing measurable.
- **Distance sampling of rays:** step 0.5 px growing 2 % per step: 0.76 % wrong at 154 µs. A constant 0.25 px step is only slightly better (0.62 %) at 6× the cost; 1 px/+5 % (1.25 %) and 2 px/+10 % (2.13 %) miss thin walls.
- Most errors are "horizon says lit, exact says shade" (thin obstacles slipping between directions): 0.55 % vs 0.21 %.

### Per terrace: sun windows
300 random terraces (4–10 m × 2–5 m, random orientation) × 4 days = 1,200 terrace-days; windows at **1-minute** resolution. Truth = exact test on **64 points** per terrace. Rule: lit when ≥ 50 % of points lit, gaps ≤ 5 min merged, windows ≥ 30 min.

| Method | Edge error (min): median | mean | 95th | Sunny minutes/day error: median | 95th |
|---|---|---|---|---|---|
| exact, 16 points | 1 | 4.8 | 13 | 2 | 24 |
| **horizon, 16 points (4×4)** | **2** | 7.3 | 17 | 4 | 33 |
| **horizon, 9 points (3×3)** | **2** | 4.7 | 12 | 2 | 20 |
| horizon, 4 points (2×2) | 6 | 16.2 | 52 | 12 | 85 |
| horizon, 1 point (centre) | 2 | 7.7 | 31 | 4 | 48 |

- **9 points are as good as 16.** An even grid (2×2, 4×4) puts "exactly half lit" right on the threshold, which counts as sunny and biases the result (2×2 is clearly worst). Use an **odd grid: 3×3**.
- **Hysteresis** (a window starts at ≥ 50 % lit, but ends only below 35 %) improves 16 points: 95th percentile 17 → 12 min, mean 7.3 → 4.5, large flips 20 → 14 of 1,200 terrace-days (1.7 % → 1.2 %). Mixed result for 9 points (noise level). Adopted because it also matches intuition (a window should not end the instant half the tables go into shade).
- **Remaining failure mode:** a terrace that sits near 50 % lit for a long stretch flips between "sunny all day" and "sunny with a 90-minute gap" on a single sample. In all inspected cases both curves hovered within 10 percentage points of the threshold. This is inherent to a hard threshold, not a bug. Mitigation in the product: show the **lit-share timeline** and a "partly sunny" state, and rank by **expected sunny area** (the sum of the lit share) rather than window length alone.

### Agreement with the GPU renderer (S1)
2,000 points × 39 sun positions = 78,000 tests, read back from the real GPU mask (run in Chrome; `s2-agreement.html`).

| Setting | GPU vs exact | GPU vs horizon | Exact vs horizon |
|---|---|---|---|
| Renderer's own rules (near-field noise filter on, observer at the surface) | 1.02 % | **1.40 %** | 0.69 % |
| Same rule everywhere (observer 1 m above the surface, no filter) | **0.31 %** | **0.93 %** | 0.76 % |

With one shared rule the renderer and the exact test agree on 99.7 %, and the horizon method adds about 0.8 % of its own, i.e. **the map and the ranking disagree on about 1 in 100 point-minutes** (98.6 % even with the renderer's different near-field rule). The test is repeatable (`npx tsx src/export-agreement.ts`, then the page).

### Speed and size
| | Result |
|---|---|
| Compute one horizon profile (144 directions) | 154 µs (Node, M3) ⇒ 5,000 terraces × 9 points = 7 s; × 16 points = 12.5 s |
| Sun windows for 300 terraces × 16 points, one summer day, 1-min resolution | **73 ms** (244 µs per terrace) |
| Same for 5,000 terraces | 1.29 s |
| Storage, 9 points × 144 bytes | 1,296 B raw per terrace; **≈ 0.73 KB with brotli** (0.9 KB gzip). 5,000 terraces ≈ 3.6 MB compressed. Delta coding between points does not help. |

Phones are typically 3–6× slower than this laptop: ≈ 0.2–0.4 s for 300 terraces for a whole day at 1-minute resolution. The ranking only needs the next few hours at 2–5 minute steps, so ≈ 10× cheaper; run it in a Web Worker.

## Decisions (feed the spec)
1. **144 directions × 1 byte (0.5° steps), linear interpolation, 500 m cap**, rays 0.5 px growing 2 %/step with early exit. One profile per point (vegetation is a second profile in M4).
2. **Terraces: 3×3 sample points** (odd grid), not "≤ 16". Parks and squares sample a grid over the polygon.
3. **Observer height: 1.0 m above bare ground (DTM).** This needs a **ground-height tile set**, now built (`build_tiles.py --kind dtm`, 1.9 MB for the 3×3 km). With the surface model alone, a terrace under a tree or awning would be judged from the canopy top and look falsely sunny.
4. **A point is covered** (always shaded) when the surface is more than 2.5 m above the ground at the point itself (canopy, awning, roof). Caveat: the data is from 2021, so retractable parasols and later awnings are not seen.
5. **Windows:** a window starts at ≥ 50 % lit and ends below 35 % (hysteresis); gaps ≤ 5 min merged; minimum 30 min.
6. Rank by the sum of the lit share ("expected sunny area") and show a lit-share timeline; do not rely on binary windows alone.
7. The horizon code is plain TypeScript with no canvas or DOM, so it runs unchanged in Node (pipeline), a Web Worker (ranking) and the browser (editor preview).

## Limits and open points
- **Everything above compares the method with the same elevation data.** Real-world accuracy cannot be measured without time-stamped ground truth at real terraces (photos showing sun or shade at a known time). S1's aerial photo gives one such time (82.8 %). Either supply 10–30 dated photos of terraces, or collect them later with "still sunny here?" check-ins (backlog).
- Trees are opaque (no seasonal transmittance yet), and the DSM is from 2021.
- Rooftop terraces (eye height from the surface, not the ground) work in the code (`eyeFrom: 'dsm'`) but were not evaluated separately.
- The region tested is the central 3×3 km (dense city). Residential and park areas with lower obstacles should be easier, but were not sampled separately.
- Sun position uses the atlas centre for all points (up to ~1.5 km away: well under a minute of difference).

## How to reproduce
```bash
cd spikes/s2-horizon && npm install
npm test                                   # 7 unit tests
npx tsx src/accuracy.ts 3000               # per-point study (≈25 s)
npx tsx src/terraces.ts 300                # per-terrace windows + speed (≈2.5 min); HYST=0.35 for hysteresis
npx tsx src/export-agreement.ts 2000 1     # then open http://localhost:5173/s2-agreement.html?file=agreement-eye1.json&bias=4&range=1e9 in Chrome
```
Needs the S1 tiles (`spikes/s1-shadow`: `fetch_tiles.py`, `build_tiles.py`, and `build_tiles.py --kind dtm`) and the S1 dev server for the GPU comparison.
