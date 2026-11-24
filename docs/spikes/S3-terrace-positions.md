# Spike S3 — Terrace positions from aerial photos: result

**Verdict: GO, with a smaller promise than the spec made.** Automatic positions (from imagery or from building footprints alone) land about **3 m** from where a person draws the terrace. That is good enough to *seed* every venue and to say "probably sunny", but a window taken from a seeded terrace is wrong in roughly 1 sun-minute out of 9, and by more than half an hour on about half of terrace-days. Once a person has corrected the polygon (≈ 1 m), the error falls to about 1 minute in 25. So: **seed automatically, show it as "estimated", and make human verification (editor + moderator review of the top venues) the way accuracy improves.**

Everything below is measured on **74 Brussels venues** in the 3×3 km area, with the 5 cm UrbIS aerial photo of 20–21 Sept 2024, using the S2 sun-window code. The reference polygons were **drawn by me and then reviewed and corrected by you** (you changed 47 of 74 venues).

Code: [spikes/s3-terraces/](../../spikes/s3-terraces/) · Spec: [SPEC.md §9](../SPEC.md) · Figure: [s3-assets/compare.jpg](s3-assets/compare.jpg)

## What was done
1. **Venues:** 1,196 OSM venues in the area; 74 picked by spread-out sampling (about 70 tagged with outdoor seating, 4 tagged `no`), mixed restaurant / café / bar / pub, centre and outskirts.
2. **Photo crops:** 60 m × 60 m from the UrbIS z21 tiles (4.7 cm/px) plus UrbIS building outlines, with a metre grid.
3. **Reference:** first pass by me, then your review in a purpose-built tool ([review.html](../../spikes/s3-terraces/review.html): drag vertices, draw/delete polygons, status, notes, Street View link). Final: **44 terraces** (42 with a polygon; Woodpecker is under tree canopy and Corica is a rooftop, so neither has one), **21 none**, 7 unsure, 1 hidden, 1 bad photo.
4. **Method A (heuristic, no imagery):** a 12 m × 6 m rectangle in front of the facade nearest the OSM point, on the free side of the building footprint.
5. **Method B (imagery classifier):** per-pixel gradient-boosted classifier (colour, texture, building distance, height-above-ground, small-object mask), trained on the reference polygons, evaluated with **10-fold cross-validation by venue** (never tested on a venue it trained on).
6. **Sun check:** for each terrace, sun windows on 21 Mar / 21 Jun / 21 Sep from the reference polygon vs each guess, with the S2 horizon code (3 days × 42 terraces = 123 terrace-days; 91 have sun in the reference).

## Results

### Where is the terrace? (42 terraces with polygons)
| | Mean overlap (IoU) | Median | IoU ≥ 0.5 | Centre error (median / 90th pct) |
|---|---|---|---|---|
| A: facade rectangle (12×6, size tuned on this set) | 0.28 | 0.27 | 6 / 42 | 3.2 m / 11.9 m |
| B: imagery classifier (cross-validated) | 0.30 | 0.29 | 5 / 42 | — |
| **Two people** (my drawing vs your correction, 23 shared terraces) | **0.68** | **0.73** | 17 / 23 | **0.8 m** / 2.4 m |

Neither automatic method reaches a 0.5 overlap on most terraces; people agree with each other far more. Typical failures ([figure](s3-assets/compare.jpg)): elevated or deck terraces (Bozar), tables in deep shade, tables on the far side of a street or tram line, a big square with several venues sharing it.

**What real terraces look like** (your polygons): median area **64 m²** (10th–90th percentile 24–199), about **14 m × 6.4 m**; the OSM point is inside the building and the polygon is a median **4.3 m** from it (centre 7.6 m, up to 20 m). Only 3 of 42 needed two polygons. The spec's "≈ 4 × 2 m" default was far too small.

### Does the position error matter for sun? (what the user actually sees)
| Position used | Sun-minutes labelled correctly | Median error in sunny minutes/day | More than 30 min wrong | More than 60 min wrong |
|---|---|---|---|---|
| OSM point only | 76.0 % | 187 min | 74 % | 73 % |
| **A: facade rectangle** | **89.2 %** | 27 min | 48 % | 32 % |
| A grown by 2 m ("blurred") | 89.7 % | 28 min | 48 % | 32 % |
| **B: imagery classifier** | **89.8 %** | 39 min | 52 % | 39 % |
| **Second person** (my drawing vs yours) | **96.7 %** | 6 min | 21 % | 6 % |
| Reference moved 1 m | 96.0 % | 11 min | 27 % | 12 % |
| Reference moved 2 m | 92.2 % | 19 min | 40 % | 26 % |
| Reference moved 3 m | 89.2 % | 28 min | 49 % | 36 % |
| Reference moved 5 m | 85.2 % | 55 min | 62 % | 47 % |

Reading: **A and B behave like a 3 m error; a second human behaves like a ~1 m error.** The OSM point alone is useless (it sits inside the building, which the sun test treats as covered). Window start/end errors follow the same pattern (second person: median 3 and 8 min; A: 20 and 15 min, with 90th percentiles around 2.5 hours).

### Does imagery tell us whether a terrace exists?
- **OSM tags are unreliable both ways.** Of the 70 venues tagged `yes` / `sidewalk` / `pedestrian_zone`: **42 have a terrace** in your review, 19 none, 7 unsure, 2 unusable → **69 % of decided venues**. My first pass (photo only) found just 23; you found 21 more that I had called "none", "unsure" or "hidden", so *not seeing tables on the photo is weak evidence of no terrace*. Of 4 venues tagged `no`, 2 have a terrace (Bozar Café Victor clearly does). The sample is too small and too skewed toward tagged venues to say how many *untagged* venues have terraces.
- **Imagery evidence is useful but not decisive:** the classifier separates terrace from non-terrace venues with an AUC of **0.81** (cross-validated; 42 vs 21 venues).
- **The photo is one sunny day** (20–21 Sept 2024): a terrace without tables set out that day looks empty, and about 1 % of z21 tiles are blurry upscales of coarser imagery (TICH).

### Does B get better with more labels?
Yes, and it has not levelled off: mean IoU **0.21 with 8 training venues, 0.24 with 16, 0.27 with 36, 0.30 with 54** (held-out venues, 3 × 7-fold). The editor is therefore also the labelling tool, and B should be retrained once a few hundred verified polygons exist.

## Decisions
1. **Seed every venue with A (no imagery) in M2.** Same accuracy as B for sun purposes, far simpler (footprints only), nothing to download. Use **12 m × 6 m**, scaled by venue type later; large squares and pedestrian-zone venues will need a person.
2. **B is not shipped yet.** Its value now is *evidence*: "tables seen / not seen" as a hint for the moderator's review queue and as the background suggestion in the editor. Revisit after ~200 verified polygons.
3. **Three position states in the data and UI:** `verified` (human-drawn, ≈ 1 m, ≈ 96 % of sun-minutes right), `seeded` (≈ 3 m, ≈ 89 %, shown as "estimated sun"), and `none found`. Never present a seeded window as exact (no "sunny until 15:42"; use "until about 15:30").
4. **Do not blur the footprint to express uncertainty** (89.7 % vs 89.2 %: no gain). Express it in the UI instead.
5. **The review tool becomes the bootstrap tool:** reuse it for the ~200 most visited terraces (M3). Keep the Street View link; it resolves cases the photo cannot.
6. **OSM `outdoor_seating` is a hint, not a fact:** show "terrace not confirmed" for untagged venues, and let users add or remove terraces for any venue.
7. Cost of the optional B path, for the record: about 6 s per venue at four parallel requests (≈ 5 h for 3,300 venues, one-off, on your Mac, free).

## Caveats (what this does *not* tell us)
- **Small sample:** 42 terraces; one city, one season, one photo day. Differences of a few points between A and B (89.2 vs 89.8) are noise.
- **The reference is not independent:** you corrected my drawing, so the "second person" figure (96.7 %) is probably optimistic; two people drawing from scratch would differ more.
- **Tuned on the same data:** A's size (12 × 6) and B's threshold were chosen on this set (B's predictions are cross-validated, A's size is not), so both are slightly flattering.
- **No real-world ground truth:** "sun-minutes labelled correctly" compares polygons *with each other* under the same 2021 elevation model. Whether a terrace was actually in sun at 15:00 still needs dated photos (an open item from S1/S2).
- **Only ground-level terraces are handled** (shadows are ground shadows); rooftop and elevated terraces are not modelled.
- 3 days (equinoxes and the June solstice) were scored, not the whole year.

## Reproduce
```
cd spikes/s3-terraces               # python = ../s1-shadow/.venv/bin/python
python select_venues.py; python select_more.py            # venues
python fetch_crops.py; python fetch_crops.py selected2.json # photo crops + building outlines
python serve_review.py                                     # review tool, http://127.0.0.1:5180/review.html
python method_b.py                                         # features + cross-validation
python export_sun.py && ../s2-horizon/node_modules/.bin/tsx sun_score.mts   # sun-window scores
python learning_curve.py; python figure.py
```
Data: `data/reference.mine.json` (my first pass), `data/reference.reviewed.json` (your review; the default reference; `REF=mine` switches). Large intermediates (`data/crops`, `data/features`, `data/sheets`…) are regenerable and not kept in git.
