// Accuracy of horizon profiles against the exact sun test, on real Brussels data.
// usage: npx tsx src/accuracy.ts [points=3000]
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadHeightMap } from './heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, isLitExact, lookupHorizon, quantizeHorizon, type HorizonOptions, type Interpolation, type Rounding } from './horizon.ts';
import { sunDay } from './sunwindows.ts';

const N_POINTS = Number(process.argv[2] ?? 3000);
const STEP_MIN = 5;

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const t0 = performance.now();
const hm = await loadHeightMap('../s1-shadow/web/public');
console.log(`loaded ${hm.size}x${hm.size} (0.754 m/px), DSM max ${hm.maxDsm.toFixed(1)} m, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// Open ground only (surface within 0.3 m of bare ground): streets, squares, courtyards, parks.
const rand = rng(42);
const margin = 700; // rays of up to 500 m stay inside the atlas
const points: [number, number][] = [];
while (points.length < N_POINTS) {
  const px = margin + rand() * (hm.size - 2 * margin), py = margin + rand() * (hm.size - 2 * margin);
  const i = Math.floor(py) * hm.size + Math.floor(px);
  if (Math.abs(hm.dsm[i] - hm.dtm[i]) < 0.3) points.push([px, py]);
}

// Four days across the year; entries are local midnight expressed in UTC.
const days = [
  { name: 'Mar 21', utc: Date.UTC(2026, 2, 21, -1) },
  { name: 'Jun 21', utc: Date.UTC(2026, 5, 21, -2) },
  { name: 'Sep 21', utc: Date.UTC(2026, 8, 21, -2) },
  { name: 'Dec 21', utc: Date.UTC(2026, 11, 21, -1) },
];
interface Sun { az: number; alt: number; day: number }
const suns: Sun[] = [];
days.forEach((d, di) => {
  const sd = sunDay(hm.centre.lat, hm.centre.lng, d.utc);
  for (let m = 0; m < 1440; m += STEP_MIN) if (sd.alt[m] > 0) suns.push({ az: sd.az[m], alt: sd.alt[m], day: di });
});
console.log(`${points.length} open-ground points x ${suns.length} sun positions (${STEP_MIN}-min steps, 4 days) = ${(points.length * suns.length / 1e6).toFixed(2)} M tests`);

// Exact reference: constant 0.25 px step, no azimuth binning.
const ref: Uint8Array[] = [];
const r0 = performance.now();
for (const [px, py] of points) {
  const row = new Uint8Array(suns.length);
  for (let s = 0; s < suns.length; s++) row[s] = isLitExact(hm, px, py, suns[s].az, suns[s].alt, DEFAULT_HORIZON) ? 1 : 0;
  ref.push(row);
}
const refMs = performance.now() - r0;
let litTotal = 0, total = 0;
for (const row of ref) for (const v of row) { litTotal += v; total++; }
console.log(`reference done in ${(refMs / 1000).toFixed(1)} s (${(refMs * 1000 / total).toFixed(2)} us per test); ${(litTotal / total * 100).toFixed(1)} % of tests are lit\n`);

interface Variant { name: string; h: Partial<HorizonOptions>; stepDeg: number; rounding: Rounding | 'float'; interp: Interpolation; pool?: number }
interface Result { name: string; bytes: number; horizonUsPerPoint: number; mismatchPct: number; falseLitPct: number; falseShadePct: number; p50: number; p95: number; max: number; minutesErrMean: number }

function evaluate(v: Variant): Result {
  const opts = { ...DEFAULT_HORIZON, ...v.h };
  const pool = v.pool ?? 1;
  const h0 = performance.now();
  // `pool` > 1: trace pool x more azimuths, then keep the highest horizon within +-half a bin, so thin
  // obstacles between two bins are not lost.
  const profiles = points.map(([px, py]) => {
    const fine = computeHorizon(hm, px, py, { ...opts, bins: opts.bins * pool })!;
    return pool === 1 ? fine : poolMax(fine, pool);
  });
  const hMs = performance.now() - h0;
  const stepDeg = v.stepDeg;
  const q = v.rounding === 'float' ? null : profiles.map((p) => quantizeHorizon(p, stepDeg, v.rounding as Rounding));
  let wrong = 0, falseLit = 0, falseShade = 0;
  const dayMismatch: number[] = [];
  for (let p = 0; p < points.length; p++) {
    const perDay = new Float64Array(days.length);
    for (let s = 0; s < suns.length; s++) {
      const hor = q ? lookupHorizon(q[p], stepDeg, suns[s].az, v.interp) : lookupFloat(profiles[p], suns[s].az, v.interp);
      const lit = suns[s].alt > hor ? 1 : 0;
      if (lit !== ref[p][s]) {
        wrong++;
        if (lit) falseLit++; else falseShade++;
        perDay[suns[s].day]++;
      }
    }
    for (const c of perDay) dayMismatch.push(c * STEP_MIN);
  }
  dayMismatch.sort((a, b) => a - b);
  const total = points.length * suns.length;
  const at = (f: number) => dayMismatch[Math.min(dayMismatch.length - 1, Math.floor(f * dayMismatch.length))];
  return {
    name: v.name, bytes: opts.bins, horizonUsPerPoint: (hMs * 1000) / points.length,
    mismatchPct: (wrong / total) * 100, falseLitPct: (falseLit / total) * 100, falseShadePct: (falseShade / total) * 100,
    p50: at(0.5), p95: at(0.95), max: dayMismatch[dayMismatch.length - 1],
    minutesErrMean: dayMismatch.reduce((a, b) => a + b, 0) / dayMismatch.length,
  };
}

function poolMax(fine: Float32Array, k: number): Float32Array {
  const bins = fine.length / k, half = Math.floor(k / 2);
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let m = 0;
    for (let j = i * k - half; j <= i * k + half; j++) m = Math.max(m, fine[((j % fine.length) + fine.length) % fine.length]);
    out[i] = m;
  }
  return out;
}

function lookupFloat(p: Float32Array, az: number, method: Interpolation): number {
  const n = p.length;
  const pos = (((az % 360) + 360) % 360) / 360 * n;
  if (method === 'nearest') return p[Math.round(pos) % n];
  const i0 = Math.floor(pos) % n, i1 = (i0 + 1) % n, f = pos - Math.floor(pos);
  return method === 'max' ? Math.max(p[i0], p[i1]) : p[i0] * (1 - f) + p[i1] * f;
}

const Q = 90 / 255;
const groups: { title: string; variants: Variant[] }[] = [
  {
    title: 'Azimuth bins (0.35 deg bytes, linear interpolation, default distance sampling)',
    variants: [36, 72, 144, 360, 720].map((bins) => ({ name: `${bins} bins`, h: { bins }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const })),
  },
  {
    title: 'Interpolation between bins (144 bins)',
    variants: (['nearest', 'linear', 'max'] as const).map((interp) => ({ name: interp, h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp })),
  },
  {
    title: 'Pooling: trace more azimuths, keep the highest horizon within +-half a bin (nearest lookup)',
    variants: [
      { name: '144 bins, no pooling (linear)', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: '144 bins, pooled from 288', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'nearest' as const, pool: 2 },
      { name: '144 bins, pooled from 576', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'nearest' as const, pool: 4 },
      { name: '144 bins, pooled from 576, linear', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const, pool: 4 },
      { name: '72 bins, pooled from 288', h: { bins: 72 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'nearest' as const, pool: 4 },
      { name: '360 bins, no pooling (linear)', h: { bins: 360 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
    ],
  },
  {
    title: 'Storage precision of the elevation angle (144 bins, linear)',
    variants: [
      { name: 'float32 (no quantisation)', h: { bins: 144 }, stepDeg: Q, rounding: 'float' as const, interp: 'linear' as const },
      { name: '0.35 deg, nearest (255 levels)', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: '0.35 deg, round up', h: { bins: 144 }, stepDeg: Q, rounding: 'up' as const, interp: 'linear' as const },
      { name: '0.5 deg, nearest', h: { bins: 144 }, stepDeg: 0.5, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: '1 deg, nearest', h: { bins: 144 }, stepDeg: 1, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: '2 deg, nearest', h: { bins: 144 }, stepDeg: 2, rounding: 'nearest' as const, interp: 'linear' as const },
    ],
  },
  {
    title: 'Distance sampling of the rays (144 bins, 0.35 deg, linear)',
    variants: [
      { name: 'fine, constant 0.25 px', h: { bins: 144, stepFine: 0.25, stepGrowth: 0 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: 'default: 0.5 px, +2 %/step', h: { bins: 144 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: 'coarse: 1 px, +5 %/step', h: { bins: 144, stepFine: 1, stepGrowth: 0.05 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
      { name: 'very coarse: 2 px, +10 %/step', h: { bins: 144, stepFine: 2, stepGrowth: 0.1 }, stepDeg: Q, rounding: 'nearest' as const, interp: 'linear' as const },
    ],
  },
];

const all: Record<string, Result[]> = {};
for (const g of groups) {
  console.log(`## ${g.title}`);
  console.log('variant'.padEnd(34) + 'bytes/pt  us/point  wrong%  falseLit%  falseShade%  min/day p50  p95   max');
  const res: Result[] = [];
  for (const v of g.variants) {
    const r = evaluate(v);
    res.push(r);
    console.log(`${r.name.padEnd(34)}${String(r.bytes).padStart(8)}  ${r.horizonUsPerPoint.toFixed(0).padStart(8)}  ${r.mismatchPct.toFixed(2).padStart(6)}  ${r.falseLitPct.toFixed(2).padStart(9)}  ${r.falseShadePct.toFixed(2).padStart(11)}  ${String(r.p50).padStart(11)} ${String(r.p95).padStart(4)} ${String(r.max).padStart(5)}`);
  }
  all[g.title] = res;
  console.log();
}
mkdirSync('out', { recursive: true });
writeFileSync('out/accuracy.json', JSON.stringify({ points: points.length, suns: suns.length, stepMin: STEP_MIN, groups: all }, null, 1));
