// Check: horizon profiles from the tile-lazy job (snapshot/) equal the ones from the S2 whole-area loader (S1 atlas).
//   ../s2-horizon/node_modules/.bin/tsx check_horizons.mts
import { readFileSync, readdirSync } from 'node:fs';
import { loadHeightMap } from '../s2-horizon/src/heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, quantizeHorizon } from '../s2-horizon/src/horizon.ts';

const hm = await loadHeightMap(new URL('../s1-shadow/web/public', import.meta.url).pathname);
const seed: { id: string; points: number[][] }[] = JSON.parse(readFileSync(new URL('./data/terraces-seed.json', import.meta.url), 'utf8'));
const snap = new Map<string, Uint8Array>();
const root = new URL('./snapshot/places/15', import.meta.url).pathname;
for (const x of readdirSync(root)) for (const f of readdirSync(`${root}/${x}`)) {
  for (const p of JSON.parse(readFileSync(`${root}/${x}/${f}`, 'utf8')).places) if (p.h) snap.set(p.id, new Uint8Array(Buffer.from(p.h, 'base64')));
}
const toPx = (lng: number, lat: number): [number, number] => {
  const wx = (lng + 180) / 360, wy = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  return [((wx - hm.originMerc[0]) / hm.sizeMerc) * hm.size, ((wy - hm.originMerc[1]) / hm.sizeMerc) * hm.size];
};
let terraces = 0, bytes = 0, equal = 0, maxDiff = 0, skipped = 0;
for (const t of seed) {
  const prof = snap.get(t.id);
  if (!prof) continue;
  const pts = t.points.map(([lng, lat]) => toPx(lng, lat));
  // Stay clear of the atlas border: S2's atlas is only 3 x 3 km, the ray margin must lie inside it.
  if (pts.some(([x, y]) => x < 800 || y < 800 || x > hm.size - 800 || y > hm.size - 800)) { skipped++; continue; }
  terraces++;
  pts.forEach(([x, y], i) => {
    const h = computeHorizon(hm, x, y, { ...DEFAULT_HORIZON, bins: 144 });
    if (!h) return;
    const q = quantizeHorizon(h, 0.5, 'nearest');
    for (let b = 0; b < 144; b++) {
      bytes++;
      const d = Math.abs(q[b] - prof[i * 144 + b]);
      if (d === 0) equal++;
      if (d > maxDiff) maxDiff = d;
    }
  });
}
console.log(`${terraces} terraces inside the S1 area (${skipped} too close to its border): ${bytes} profile bytes, ${(100 * equal / bytes).toFixed(3)}% identical, max difference ${maxDiff} x 0.5 deg`);
