// Spike S4, pipeline step 4: horizon profiles for every seeded terrace, straight from the published z17 height tiles,
// and the place snapshot chunks (one JSON per z15 tile).
//
//   TILES=out  npx tsx horizons.mts                          # tiles from a folder
//   TILES=https://vitamine-d-s4-test.pages.dev/urbis-2021 npx tsx horizons.mts   # tiles from the static host
//   options: --limit N (first N terraces)  --check (compare with the whole-area S2 loader, needs the S1 tiles)
//
// Memory stays flat: one local raster per z15 cell (cell + 520 m ray margin) built from a small LRU of decoded tiles.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync } from 'node:zlib';
import { decodePng } from '../s1-shadow/web/src/png.ts';
import { DEFAULT_HORIZON, computeHorizon, quantizeHorizon } from '../s2-horizon/src/horizon.ts';
import type { HeightMap } from '../s2-horizon/src/heightmap.ts';

const TILES = (process.env.TILES ?? new URL('./out', import.meta.url).pathname).replace(/\/$/, '');
const REMOTE = /^https?:/.test(TILES);
const Z = 17, TILE = 256, OFFSET = 10, STEP = 0.25, BINS = 144, QSTEP = 0.5;
const CELL_PX = 1024; // one z15 tile in z17 pixels
const MARGIN_PX = Math.ceil(DEFAULT_HORIZON.maxDistM / 0.754) + 8;
const limit = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const OUT = new URL('./snapshot', import.meta.url).pathname;

interface Terrace { id: string; name: string; type: string; seating: string; lat: number; lng: number; status: string; fallback: boolean; polygon: number[][]; points: number[][] }
const terraces: Terrace[] = JSON.parse(readFileSync(new URL('./data/terraces-seed.json', import.meta.url), 'utf8')).slice(0, limit);

async function readIndex(kind: string): Promise<Set<string>> {
  const buf = REMOTE ? new TextDecoder().decode(await get(`${TILES}/${kind}/index.json`)) : readFileSync(`${TILES}/${kind}/index.json`, 'utf8');
  const idx = JSON.parse(buf);
  const set = new Set<string>();
  for (const [y, runs] of Object.entries(idx.rows) as [string, number[][]][]) for (const [a, b] of runs) for (let x = a; x <= b; x++) set.add(`${x}/${y}`);
  return set;
}

// Remote reads: at most 16 requests in flight, each retried with backoff (transient DNS/network errors happen).
let inflight = 0;
const waiting: (() => void)[] = [];
async function get(url: string): Promise<ArrayBuffer> {
  while (inflight >= 16) await new Promise<void>((r) => waiting.push(r));
  inflight++;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'vitamine-d-pipeline/0.1' } });
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return await r.arrayBuffer();
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      }
    }
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

const have = { dsm: await readIndex('dsm'), dtm: await readIndex('dtm') };
const cache = new Map<string, Float32Array | null>();
const stats = { tilesDecoded: 0, bytes: 0 };
async function tile(kind: 'dsm' | 'dtm', x: number, y: number): Promise<Float32Array | null> {
  const key = `${kind}/${x}/${y}`;
  if (cache.has(key)) { const v = cache.get(key)!; cache.delete(key); cache.set(key, v); return v; }
  let out: Float32Array | null = null;
  if (have[kind].has(`${x}/${y}`)) {
    const path = `${TILES}/${kind}/${Z}/${x}/${y}.png`;
    let buf: ArrayBuffer;
    if (REMOTE) {
      buf = await get(path);
    } else {
      const b = await readFile(path);
      buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
    const img = await decodePng(buf);
    out = new Float32Array(TILE * TILE);
    for (let i = 0; i < out.length; i++) {
      const v = (img.data[i * 4] << 8) | img.data[i * 4 + 1];
      out[i] = v === 0 ? NaN : v * STEP - OFFSET;
    }
    stats.tilesDecoded++; stats.bytes += buf.byteLength;
  }
  cache.set(key, out);
  if (cache.size > 700) cache.delete(cache.keys().next().value!);
  return out;
}

const world = (lng: number, lat: number): [number, number] => {
  const n = 2 ** Z * TILE;
  return [((lng + 180) / 360) * n, ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n];
};

async function localMap(cx: number, cy: number, lat: number): Promise<{ hm: HeightMap; px0: number; py0: number }> {
  const size = CELL_PX + 2 * MARGIN_PX;
  const px0 = cx * CELL_PX - MARGIN_PX, py0 = cy * CELL_PX - MARGIN_PX;
  const dsm = new Float32Array(size * size).fill(NaN), dtm = new Float32Array(size * size).fill(NaN);
  const jobs: Promise<void>[] = [];
  for (let ty = Math.floor(py0 / TILE); ty <= Math.floor((py0 + size - 1) / TILE); ty++) {
    for (let tx = Math.floor(px0 / TILE); tx <= Math.floor((px0 + size - 1) / TILE); tx++) {
      jobs.push((async () => {
        const [a, b] = await Promise.all([tile('dsm', tx, ty), tile('dtm', tx, ty)]);
        for (const [src, dst] of [[a, dsm], [b, dtm]] as const) {
          if (!src) continue;
          for (let y = 0; y < TILE; y++) {
            const gy = ty * TILE + y - py0;
            if (gy < 0 || gy >= size) continue;
            for (let x = 0; x < TILE; x++) {
              const gx = tx * TILE + x - px0;
              if (gx >= 0 && gx < size) dst[gy * size + gx] = src[y * TILE + x];
            }
          }
        }
      })());
    }
  }
  await Promise.all(jobs);
  let maxDsm = -Infinity;
  for (const v of dsm) if (v > maxDsm) maxDsm = v;
  const mpp = (156543.03392804097 / 2 ** Z) * Math.cos((lat * Math.PI) / 180);
  return { hm: { size, mpp, dsm, dtm, maxDsm, centre: { lat, lng: 0 }, originMerc: [0, 0], sizeMerc: 0 }, px0, py0 };
}

// ---- main ---------------------------------------------------------------------------------------------------------
const t0 = performance.now();
const cells = new Map<string, Terrace[]>();
for (const t of terraces) {
  const [wx, wy] = world(t.lng, t.lat);
  const k = `${Math.floor(wx / CELL_PX)}/${Math.floor(wy / CELL_PX)}`;
  (cells.get(k) ?? cells.set(k, []).get(k)!).push(t);
}
rmSync(OUT, { recursive: true, force: true });
let pointMs = 0, points = 0, missing = 0, covered = 0, rss = 0, bytesRaw = 0, bytesBr = 0, files = 0, cellN = 0;
const order = [...cells].sort(([a], [b]) => { const [ax, ay] = a.split('/').map(Number), [bx, by] = b.split('/').map(Number); return ay - by || ax - bx; }); // row by row keeps neighbouring cells' tiles in the cache
for (const [k, list] of order) {
  const [cx, cy] = k.split('/').map(Number);
  const { hm, px0, py0 } = await localMap(cx, cy, list[0].lat);
  const places = [];
  for (const t of list) {
    const prof = new Uint8Array(t.points.length * BINS);
    let ok = true;
    t.points.forEach(([lng, lat], i) => {
      const [wx, wy] = world(lng, lat);
      const p0 = performance.now();
      const h = computeHorizon(hm, wx - px0, wy - py0, { ...DEFAULT_HORIZON, bins: BINS });
      pointMs += performance.now() - p0; points++;
      if (!h) { ok = false; missing++; return; }
      if (h[0] === 90 && h[BINS >> 1] === 90) covered++;
      prof.set(quantizeHorizon(h, QSTEP, 'nearest'), i * BINS);
    });
    places.push({ id: t.id, name: t.name, type: t.type, seating: t.seating, lat: t.lat, lng: t.lng, status: t.status, fallback: t.fallback || undefined,
      polygon: t.polygon, h: ok ? Buffer.from(prof).toString('base64') : null });
  }
  const dir = `${OUT}/places/15/${cx}`;
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({ v: 1, dsm: 'urbis-2021', qstep: QSTEP, bins: BINS, points: 9, places });
  writeFileSync(`${dir}/${cy}.json`, json);
  bytesRaw += json.length; bytesBr += brotliCompressSync(Buffer.from(json)).length; files++;
  rss = Math.max(rss, process.memoryUsage().rss);
  if (++cellN % 20 === 0) console.log(`  ${cellN}/${cells.size} cells, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
const wall = (performance.now() - t0) / 1000;
console.log(`${terraces.length} terraces in ${cells.size} z15 cells, ${points} horizon points (${missing} outside coverage, ${covered} covered)`);
console.log(`wall ${wall.toFixed(1)}s | tiles decoded ${stats.tilesDecoded} (${(stats.bytes / 1e6).toFixed(0)} MB ${REMOTE ? 'downloaded' : 'read'}) | horizon maths ${(pointMs / 1000).toFixed(1)}s (${((pointMs / points) * 1000).toFixed(0)} µs/point) | peak RSS ${(rss / 1e6).toFixed(0)} MB`);
console.log(`snapshot: ${files} files, ${(bytesRaw / 1e6).toFixed(2)} MB raw, ${(bytesBr / 1e6).toFixed(2)} MB brotli (${(bytesBr / terraces.length).toFixed(0)} B per terrace)`);
