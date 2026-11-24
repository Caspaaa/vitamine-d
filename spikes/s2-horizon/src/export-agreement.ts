// Exports sample points, sun positions, and the horizon / exact answers so the browser can compare them
// with the GPU shadow renderer (the renderer starts its rays at the surface, so eyeFrom = 'dsm', eyeM = 0).
// usage: npx tsx src/export-agreement.ts [points=2000]
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadHeightMap } from './heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, isLitExact, lookupHorizon, quantizeHorizon, type HorizonOptions } from './horizon.ts';
import { sunDay } from './sunwindows.ts';

const N = Number(process.argv[2] ?? 2000);
// Observer height above the surface at the point. 0 = what the renderer does by default; 1 = a person at a table.
const EYE = Number(process.argv[3] ?? 0);
const BINS = 144;
const STEP_DEG = 0.5;

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hm = await loadHeightMap('../s1-shadow/web/public');
const rand = rng(99);
const margin = 700;
const points: [number, number][] = [];
while (points.length < N) {
  // Integer pixel + 0.5 = pixel centre, exactly where the GPU samples.
  const px = Math.floor(margin + rand() * (hm.size - 2 * margin)) + 0.5, py = Math.floor(margin + rand() * (hm.size - 2 * margin)) + 0.5;
  const i = Math.floor(py) * hm.size + Math.floor(px);
  if (Math.abs(hm.dsm[i] - hm.dtm[i]) < 0.3) points.push([px, py]);
}

const opts: HorizonOptions = { ...DEFAULT_HORIZON, bins: BINS, eyeFrom: 'dsm', eyeM: EYE };
const profiles = points.map(([x, y]) => quantizeHorizon(computeHorizon(hm, x, y, opts)!, STEP_DEG, 'nearest'));

// Sun positions: every 2 hours of daylight on four days, plus low-sun cases (long shadows are the hard part).
const suns: { az: number; alt: number; label: string }[] = [];
for (const [name, utc] of [['Mar 21', Date.UTC(2026, 2, 21, -1)], ['Jun 21', Date.UTC(2026, 5, 21, -2)], ['Sep 21', Date.UTC(2026, 8, 21, -2)], ['Dec 21', Date.UTC(2026, 11, 21, -1)]] as const) {
  const sd = sunDay(hm.centre.lat, hm.centre.lng, utc);
  for (let m = 0; m < 1440; m += 90) if (sd.alt[m] > 2) suns.push({ az: sd.az[m], alt: sd.alt[m], label: `${name} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
}
for (const alt of [3, 5, 8]) for (const az of [100, 200, 260]) suns.push({ az, alt, label: `low sun az ${az} alt ${alt}` });

const horizonLit: string[] = [], exactLit: string[] = [];
for (const s of suns) {
  let h = '', e = '';
  points.forEach(([x, y], i) => {
    h += s.alt > lookupHorizon(profiles[i], STEP_DEG, s.az, 'linear') ? '1' : '0';
    e += isLitExact(hm, x, y, s.az, s.alt, opts) ? '1' : '0';
  });
  horizonLit.push(h);
  exactLit.push(e);
}
mkdirSync('../s1-shadow/web/public/s2', { recursive: true });
writeFileSync(`../s1-shadow/web/public/s2/agreement${EYE ? `-eye${EYE}` : ''}.json`, JSON.stringify({ points, suns, horizonLit, exactLit }));
console.log(`${points.length} points x ${suns.length} suns written (eye height ${EYE} m)`);
