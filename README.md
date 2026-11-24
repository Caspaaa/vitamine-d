# Vitamine D

Where is the sun right now in Brussels? A mobile-first web app that shows the live shadows of every building and tree for any date and time, and (next) suggests nearby terraces, parks and squares that are sunny now or soon.

- Product and design: [docs/SPEC.md](docs/SPEC.md)
- Current state: [docs/M1-shadows-on-brussels.md](docs/M1-shadows-on-brussels.md) (milestone M1)
- De-risking spikes: [S1 renderer](docs/spikes/S1-shadow-renderer.md) · [S2 horizon profiles](docs/spikes/S2-horizon-profiles.md) · [S3 terrace positions](docs/spikes/S3-terrace-positions.md) · [S4 pipeline and hosting](docs/spikes/S4-pipeline-hosting.md)

Constraint: **nothing in this project may cost money** (free tiers only, no paid services).

## Layout
```
apps/web/          Next.js 16 static-export PWA: map, search, time panel, 5 languages
packages/sun/      sun position and Brussels time handling (pure TypeScript)
packages/shadow/   WebGL 2 shadow engine: ring-buffer height window + MapLibre custom layer
spikes/            the time-boxed experiments behind the spec (own tooling, not part of the workspace)
docs/              spec and results
```

## Run it
Needs Node 22+ and pnpm 12. The height tiles are not in the repo (230 MB): build them once with the S4 pipeline (see [S4, "Reproduce"](docs/spikes/S4-pipeline-hosting.md)), then:

```bash
pnpm install
pnpm --filter @vitamine/web data:link    # links the tiles into the dev server
pnpm dev                                 # http://localhost:3000
```

Without tiles the map still works and says that shadows are unavailable.

## Check it
```bash
pnpm typecheck
pnpm test                                # unit tests
pnpm --filter @vitamine/shadow e2e       # GPU harness (synthetic world, real WebGL 2)
pnpm --filter @vitamine/web e2e          # app tests on Chromium + WebKit (needs the tiles and the dev server)
```
First time only: `pnpm --filter @vitamine/web exec playwright install chromium webkit`.

## Build
```bash
NEXT_PUBLIC_DATA_URL=https://<tiles-host>/urbis-2021 pnpm build   # static site in apps/web/out
```
The build never contains the height tiles: they are published separately and read cross-origin (they must send CORS headers).

## Data and credits
Heights © UrbIS / Paradigm (CC0), 2021 · Basemap © OpenFreeMap, © OpenMapTiles, data from OpenStreetMap · Search © Photon (Komoot).
