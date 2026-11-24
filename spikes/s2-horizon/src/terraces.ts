// Terrace-level accuracy and speed: sun windows from horizon profiles vs the exact test.
// usage: npx tsx src/terraces.ts [terraces=300]
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadHeightMap, type HeightMap } from './heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, isLitExact, quantizeHorizon } from './horizon.ts';
import { DEFAULT_WINDOWS, litFractionSeries, sunDay, sunWindows, sunnyMinutes, windowsFromSeries, type SunDay, type SunWindow } from './sunwindows.ts';

const N_TERRACES = Number(process.argv[2] ?? 300);
const OFF = process.env.HYST ? Number(process.env.HYST) : undefined; // lower threshold for ending a window
const CFG = { ...DEFAULT_WINDOWS, litFractionOff: OFF };
console.log(`window config: on at >= ${CFG.litFraction}, off below ${CFG.litFractionOff ?? CFG.litFraction}, min ${CFG.minWindowMin} min, merge gaps <= ${CFG.mergeGapMin} min`);
const STEP_DEG = 0.5;
const BINS = 144;

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hm: HeightMap = await loadHeightMap('../s1-shadow/web/public');
const rand = rng(7);

interface Terrace { cx: number; cy: number; w: number; d: number; angle: number }
const margin = 700;
const terraces: Terrace[] = [];
while (terraces.length < N_TERRACES) {
  const cx = margin + rand() * (hm.size - 2 * margin), cy = margin + rand() * (hm.size - 2 * margin);
  const i = Math.floor(cy) * hm.size + Math.floor(cx);
  if (Math.abs(hm.dsm[i] - hm.dtm[i]) >= 0.3) continue;
  terraces.push({ cx, cy, w: (4 + rand() * 6) / hm.mpp, d: (2 + rand() * 3) / hm.mpp, angle: rand() * Math.PI });
}

/** n x n sample points at the centres of an n x n grid over the terrace rectangle. */
function samplePoints(t: Terrace, n: number): [number, number][] {
  const out: [number, number][] = [];
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const u = ((a + 0.5) / n - 0.5) * t.w, v = ((b + 0.5) / n - 0.5) * t.d;
    out.push([t.cx + u * c - v * s, t.cy + u * s + v * c]);
  }
  return out;
}

const days: { name: string; utc: number; sun: SunDay }[] = [
  { name: 'Mar 21', utc: Date.UTC(2026, 2, 21, -1) },
  { name: 'Jun 21', utc: Date.UTC(2026, 5, 21, -2) },
  { name: 'Sep 21', utc: Date.UTC(2026, 8, 21, -2) },
  { name: 'Dec 21', utc: Date.UTC(2026, 11, 21, -1) },
].map((d) => ({ ...d, sun: sunDay(hm.centre.lat, hm.centre.lng, d.utc) }));

/** Exact per-minute lit fraction for a set of points. */
function exactFraction(pts: [number, number][], sun: SunDay): Float32Array {
  const out = new Float32Array(sun.az.length);
  for (let m = 0; m < out.length; m++) {
    if (sun.alt[m] <= 0) continue;
    let lit = 0;
    for (const [x, y] of pts) if (isLitExact(hm, x, y, sun.az[m], sun.alt[m], DEFAULT_HORIZON)) lit++;
    out[m] = lit / pts.length;
  }
  return out;
}

function profilesFor(pts: [number, number][]): Uint8Array[] {
  return pts.map(([x, y]) => quantizeHorizon(computeHorizon(hm, x, y, { ...DEFAULT_HORIZON, bins: BINS })!, STEP_DEG, 'nearest'));
}

interface Compare { startErr: number[]; endErr: number[]; missing: number; extra: number; truthWindows: number; sunnyDiff: number }
function compare(truth: SunWindow[], test: SunWindow[], truthSunny: number, testSunny: number): Compare {
  const startErr: number[] = [], endErr: number[] = [];
  let missing = 0;
  const used = new Set<number>();
  for (const w of truth) {
    let best = -1, bestOv = 0;
    test.forEach((v, i) => {
      const ov = Math.min(w.end, v.end) - Math.max(w.start, v.start);
      if (ov > bestOv) { bestOv = ov; best = i; }
    });
    if (best < 0) { missing++; continue; }
    used.add(best);
    startErr.push(test[best].start - w.start);
    endErr.push(test[best].end - w.end);
  }
  return { startErr, endErr, missing, extra: test.length - used.size, truthWindows: truth.length, sunnyDiff: testSunny - truthSunny };
}

const pct = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const abs = (xs: number[]) => xs.map(Math.abs);

type Method = { name: string; pts: number; exact: boolean };
const methods: Method[] = [
  { name: 'exact, 16 pts', pts: 4, exact: true },
  { name: 'horizon, 16 pts (4x4)', pts: 4, exact: false },
  { name: 'horizon, 9 pts (3x3)', pts: 3, exact: false },
  { name: 'horizon, 4 pts (2x2)', pts: 2, exact: false },
  { name: 'horizon, 1 pt (centre)', pts: 1, exact: false },
];
const TRUTH_N = 8; // 8x8 = 64 exact points: the reference for the terrace's real sunny area

const agg: Record<string, { edge: number[]; sunny: number[]; missing: number; extra: number; windows: number }> = {};
for (const m of methods) agg[m.name] = { edge: [], sunny: [], missing: 0, extra: 0, windows: 0 };
let terraceDays = 0, terraceDaysWithSun = 0, truthSunnyTotal = 0;
const worst: { err: number; terrace: number; day: string; truth: SunWindow[]; test: SunWindow[]; truthFrac: Float32Array; testFrac: Float32Array }[] = [];

const t0 = performance.now();
terraces.forEach((t, ti) => {
  const truthPts = samplePoints(t, TRUTH_N);
  const cache = new Map<number, Uint8Array[]>();
  for (const d of days) {
    const truthFrac = exactFraction(truthPts, d.sun);
    const truthSunny = sunnyMinutes(truthFrac, CFG);
    const truthWin = windowsFromSeries(truthSunny, CFG);
    const truthMin = truthSunny.reduce((a, b) => a + b, 0);
    terraceDays++;
    if (truthWin.length) terraceDaysWithSun++;
    truthSunnyTotal += truthMin;
    for (const m of methods) {
      let frac: Float32Array;
      if (m.exact) frac = exactFraction(samplePoints(t, m.pts), d.sun);
      else {
        if (!cache.has(m.pts)) cache.set(m.pts, profilesFor(samplePoints(t, m.pts)));
        frac = litFractionSeries({ points: cache.get(m.pts)! }, STEP_DEG, d.sun, 'linear');
      }
      const sunny = sunnyMinutes(frac, CFG);
      const win = windowsFromSeries(sunny, CFG);
      const c = compare(truthWin, win, truthMin, sunny.reduce((a, b) => a + b, 0));
      if (m.name === 'horizon, 16 pts (4x4)') {
        const err = Math.max(0, ...abs(c.startErr), ...abs(c.endErr));
        if (err >= 60) worst.push({ err, terrace: ti, day: d.name, truth: truthWin, test: win, truthFrac, testFrac: frac });
      }
      const a = agg[m.name];
      a.edge.push(...abs(c.startErr), ...abs(c.endErr));
      a.sunny.push(Math.abs(c.sunnyDiff));
      a.missing += c.missing; a.extra += c.extra; a.windows += c.truthWindows;
    }
  }
  if ((ti + 1) % 50 === 0) console.log(`  ${ti + 1}/${terraces.length} terraces, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
});

console.log(`\n${terraces.length} terraces x 4 days = ${terraceDays} terrace-days; ${terraceDaysWithSun} have at least one sun window (truth = exact test on 64 points)`);
console.log(`truth: mean ${(truthSunnyTotal / terraceDays / 60).toFixed(1)} sunny hours per terrace-day\n`);
console.log('method'.padEnd(26) + 'edge error (min): median  mean   p95    max | sunny min/day |err|: median  p95 | windows missing  extra (of truth)');
for (const m of methods) {
  const a = agg[m.name];
  console.log(
    `${m.name.padEnd(26)}${String(pct(a.edge, 0.5)).padStart(24)}${(a.edge.reduce((x, y) => x + y, 0) / a.edge.length).toFixed(1).padStart(7)}${String(pct(a.edge, 0.95)).padStart(6)}${String(Math.max(...a.edge)).padStart(7)}` +
    ` |${String(pct(a.sunny, 0.5)).padStart(24)}${String(pct(a.sunny, 0.95)).padStart(5)} |${String(a.missing).padStart(16)}${String(a.extra).padStart(7)}  (${a.windows})`,
  );
}

if (worst.length) {
  worst.sort((a, b) => b.err - a.err);
  console.log(`\n## Cases with an edge error of 60 min or more (horizon 16 pts): ${worst.length} of ${terraceDays} terrace-days`);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const fmt = (w: SunWindow[]) => w.map((x) => `${hhmm(x.start)}-${hhmm(x.end)}`).join(' ') || '(none)';
  for (const w of worst.slice(0, 4)) {
    // How close to the 50 % threshold do the two series get while they disagree?
    let nearThreshold = 0, differing = 0;
    for (let m = 0; m < w.truthFrac.length; m++) {
      const a = w.truthFrac[m] >= 0.5, b = w.testFrac[m] >= 0.5;
      if (a !== b) { differing++; if (Math.abs(w.truthFrac[m] - 0.5) < 0.1 && Math.abs(w.testFrac[m] - 0.5) < 0.1) nearThreshold++; }
    }
    console.log(`terrace ${w.terrace} ${w.day}: err ${w.err} min`);
    console.log(`   truth:   ${fmt(w.truth)}`);
    console.log(`   horizon: ${fmt(w.test)}`);
    console.log(`   ${differing} minutes differ, ${nearThreshold} of them with both lit fractions within 0.1 of the 50 % threshold`);
  }
}

// ---- speed ---------------------------------------------------------------------------------------------------------
console.log('\n## Speed (this machine: Apple M3, Node 22; phones are typically 3-6x slower)');
const sun = days[1].sun; // longest day = worst case
const sets: Uint8Array[][] = [];
for (let i = 0; i < 5000; i++) sets.push(profilesFor(samplePoints(terraces[i % terraces.length], 4)).slice(0, 16));
for (const n of [300, 1000, 5000]) {
  const s0 = performance.now();
  let w = 0;
  for (let i = 0; i < n; i++) w += sunWindows({ points: sets[i] }, STEP_DEG, sun, 'linear', DEFAULT_WINDOWS).length;
  const ms = performance.now() - s0;
  console.log(`sun windows for ${String(n).padStart(4)} terraces x 16 points, one summer day: ${ms.toFixed(0).padStart(5)} ms  (${(ms / n * 1000).toFixed(0)} us per terrace)  [${w} windows]`);
}
const h0 = performance.now();
for (let i = 0; i < 200; i++) computeHorizon(hm, terraces[i % terraces.length].cx, terraces[i % terraces.length].cy, { ...DEFAULT_HORIZON, bins: BINS });
const hus = ((performance.now() - h0) * 1000) / 200;
console.log(`horizon profile computation: ${hus.toFixed(0)} us per point (${BINS} bins) => 5000 terraces x 16 points = ${(hus * 80000 / 1e6).toFixed(1)} s`);
console.log(`storage: ${BINS} bytes per point => ${BINS * 16} B per 16-point terrace; 5000 terraces = ${(BINS * 16 * 5000 / 1e6).toFixed(1)} MB raw`);

mkdirSync('out', { recursive: true });
writeFileSync('out/terraces.json', JSON.stringify({ terraces: terraces.length, terraceDays, terraceDaysWithSun, summary: Object.fromEntries(Object.entries(agg).map(([k, a]) => [k, { edgeMedian: pct(a.edge, 0.5), edgeP95: pct(a.edge, 0.95), sunnyMedian: pct(a.sunny, 0.5), sunnyP95: pct(a.sunny, 0.95), missing: a.missing, extra: a.extra, windows: a.windows }])) }, null, 1));
