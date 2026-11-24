// Sun-window agreement between the reference terrace and each automatic guess (A, B, P = OSM point).
// usage: ../s2-horizon/node_modules/.bin/tsx sun_score.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { loadHeightMap } from '../s2-horizon/src/heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, quantizeHorizon } from '../s2-horizon/src/horizon.ts';
import { DEFAULT_WINDOWS, litFractionSeries, sunDay, sunnyMinutes, windowsFromSeries } from '../s2-horizon/src/sunwindows.ts';

const hm = await loadHeightMap(new URL('../s1-shadow/web/public', import.meta.url).pathname);
const input = JSON.parse(readFileSync(new URL('./data/sun_input.json', import.meta.url), 'utf8')) as Record<
  string, { name: string; lng: number; lat: number; sets: Record<string, [number, number][]> }>;
const STEP = 0.5, BINS = 144;
const days = [
  { name: 'Mar 21', utc: Date.UTC(2026, 2, 21, -1) },
  { name: 'Jun 21', utc: Date.UTC(2026, 5, 21, -2) },
  { name: 'Sep 21', utc: Date.UTC(2026, 8, 21, -2) },
].map((d) => ({ ...d, sun: sunDay(hm.centre.lat, hm.centre.lng, d.utc) }));

function toPx(lng: number, lat: number, x: number, y: number): [number, number] {
  const wx = (lng + 180) / 360;
  const wy = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  const mpp = hm.mpp * Math.cos((lat * Math.PI) / 180) / Math.cos((hm.centre.lat * Math.PI) / 180);
  return [((wx - hm.originMerc[0]) / hm.sizeMerc) * hm.size + x / mpp, ((wy - hm.originMerc[1]) / hm.sizeMerc) * hm.size - y / mpp];
}

function series(v: { lng: number; lat: number }, pts: [number, number][], day: (typeof days)[number]) {
  const profiles: Uint8Array[] = [];
  for (const [x, y] of pts) {
    const [px, py] = toPx(v.lng, v.lat, x, y);
    const h = computeHorizon(hm, px, py, { ...DEFAULT_HORIZON, bins: BINS });
    if (h) profiles.push(quantizeHorizon(h, STEP, 'nearest'));
  }
  if (!profiles.length) return null;
  const frac = litFractionSeries({ points: profiles }, STEP, day.sun, 'linear');
  const sunny = sunnyMinutes(frac, DEFAULT_WINDOWS);
  return { frac, sunny, windows: windowsFromSeries(sunny, DEFAULT_WINDOWS) };
}

interface Row { vid: string; day: string; set: string; dSunny: number; agree: number; rmse: number; startErr: number | null; endErr: number | null; refSunny: number; missed: boolean }
const rows: Row[] = [];
for (const [vid, v] of Object.entries(input)) {
  for (const day of days) {
    const ref = series(v, v.sets.ref, day);
    if (!ref) continue;
    const refMin = ref.sunny.reduce((a, b) => a + b, 0);
    for (const set of Object.keys(v.sets).filter((k) => k !== 'ref')) {
      const s = v.sets[set].length ? series(v, v.sets[set], day) : null;
      let dSunny = 0, agree = 1, rmse = 0, se: number | null = null, ee: number | null = null, missed = false;
      if (!s) { dSunny = -refMin; missed = true; }
      else {
        const sMin = s.sunny.reduce((a, b) => a + b, 0);
        dSunny = sMin - refMin;
        let n = 0, same = 0, sq = 0;
        for (let m = 0; m < 1440; m++) {
          if (day.sun.alt[m] <= 0) continue;
          n++;
          if (s.sunny[m] === ref.sunny[m]) same++;
          sq += (s.frac[m] - ref.frac[m]) ** 2;
        }
        agree = same / n; rmse = Math.sqrt(sq / n);
        if (ref.windows.length && s.windows.length) {
          const rw = ref.windows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
          const sw = s.windows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
          se = sw.start - rw.start; ee = sw.end - rw.end;
        }
      }
      rows.push({ vid, day: day.name, set, dSunny, agree, rmse, startErr: se, endErr: ee, refSunny: refMin, missed });
    }
  }
}
writeFileSync(new URL('./data/sun_rows.json', import.meta.url), JSON.stringify(rows));

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
console.log('Terrace-days with at least 30 min of sun in the reference vs all:');
for (const scope of ['all', 'sunny'] as const) {
  console.log(`\n== ${scope === 'all' ? 'all terrace-days' : 'terrace-days where the reference has sun'} ==`);
  console.log('set   n   |dSunny| median  p90   >30min   >60min   minute-agreement   start err med|p90   end err med|p90');
  const group = (s: string) => (s.startsWith('shift') ? s.split('_')[0] : s);
  for (const set of ['P', 'A', 'Aw', 'B', 'Bw', 'H', 'shift1', 'shift2', 'shift3', 'shift5']) {
    const r = rows.filter((x) => group(x.set) === set && (scope === 'all' || x.refSunny >= 30));
    const ad = r.map((x) => Math.abs(x.dSunny));
    const se = r.filter((x) => x.startErr !== null).map((x) => Math.abs(x.startErr!));
    const ee = r.filter((x) => x.endErr !== null).map((x) => Math.abs(x.endErr!));
    console.log(`${set}  ${String(r.length).padStart(3)}   ${q(ad, 0.5).toFixed(0).padStart(5)} min   ${q(ad, 0.9).toFixed(0).padStart(4)}   ${(100 * ad.filter((v) => v > 30).length / r.length).toFixed(0).padStart(4)}%   ${(100 * ad.filter((v) => v > 60).length / r.length).toFixed(0).padStart(4)}%     ${(100 * r.reduce((a, x) => a + x.agree, 0) / r.length).toFixed(1)}%          ${q(se, 0.5).toFixed(0)}|${q(se, 0.9).toFixed(0)}      ${q(ee, 0.5).toFixed(0)}|${q(ee, 0.9).toFixed(0)}`);
  }
}
