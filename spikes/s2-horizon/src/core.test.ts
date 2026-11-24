import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HeightMap } from './heightmap.ts';
import { DEFAULT_HORIZON, computeHorizon, isLitExact, lookupHorizon, quantizeHorizon } from './horizon.ts';
import { sunDay, windowsFromSeries } from './sunwindows.ts';

/** Flat ground at 0 m with one box (x, y in pixels, height in metres). Pixel size 0.75 m. */
function world(box: { x0: number; x1: number; y0: number; y1: number; h: number }): HeightMap {
  const size = 400;
  const dsm = new Float32Array(size * size);
  const dtm = new Float32Array(size * size);
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) dsm[y * size + x] = box.h;
  return { size, mpp: 0.75, dsm, dtm, maxDsm: box.h, centre: { lat: 50.85, lng: 4.35 }, originMerc: [0, 0], sizeMerc: 1 };
}

const opts = { ...DEFAULT_HORIZON, bins: 72 };

test('horizon toward a wall: atan((height - eye) / distance), zero elsewhere', () => {
  // Wall 10 m high, 40 px = 30 m south of the observer at (200, 200).
  const hm = world({ x0: 100, x1: 300, y0: 240, y1: 260, h: 10 });
  const h = computeHorizon(hm, 200, 200, opts)!;
  const expected = (Math.atan((10 - 1) / 30) * 180) / Math.PI; // 16.7 degrees
  assert.ok(Math.abs(h[36] - expected) < 0.5, `south bin ${h[36]} vs ${expected}`); // bin 36 of 72 = 180 degrees
  assert.equal(h[0], 0, 'north is open');
  assert.equal(h[18], 0, 'east is open');
});

test('a point under cover never sees the sun', () => {
  const hm = world({ x0: 190, x1: 210, y0: 190, y1: 210, h: 6 });
  const h = computeHorizon(hm, 200, 200, opts)!;
  assert.ok(h.every((v) => v === 90));
});

test('exact test and horizon profile agree around the wall', () => {
  const hm = world({ x0: 100, x1: 300, y0: 240, y1: 260, h: 10 });
  const h = computeHorizon(hm, 200, 200, opts)!;
  const q = quantizeHorizon(h, 90 / 255);
  for (const alt of [10, 15, 20, 30]) {
    const exact = isLitExact(hm, 200, 200, 180, alt, opts);
    const fromProfile = alt > lookupHorizon(q, 90 / 255, 180, 'linear');
    assert.equal(fromProfile, exact, `alt ${alt}`);
  }
  assert.equal(isLitExact(hm, 200, 200, 180, 30, opts), true);
  assert.equal(isLitExact(hm, 200, 200, 180, 10, opts), false);
  assert.equal(isLitExact(hm, 200, 200, 0, 10, opts), true, 'sun in the north, wall in the south');
});

test('lookup interpolates between bins and wraps around north', () => {
  const q = Uint8Array.from([0, 100, 0, 0]); // 4 bins: N, E, S, W
  assert.equal(lookupHorizon(q, 1, 90, 'linear'), 100);
  assert.equal(lookupHorizon(q, 1, 45, 'linear'), 50);
  assert.equal(lookupHorizon(q, 1, 45, 'max'), 100);
  // 350 degrees is 8/9 of the way from the west bin (270 degrees, value 80) to the north bin (360 degrees, value 40).
  const wrapped = lookupHorizon(Uint8Array.from([40, 0, 0, 80]), 1, 350, 'linear');
  assert.ok(Math.abs(wrapped - (80 / 9 + (40 * 8) / 9)) < 1e-4, `wrapped ${wrapped}`);
});

test('quantisation: rounding up never lowers the horizon', () => {
  const deg = Float32Array.from([0, 0.1, 12.34, 60.01, 90]);
  const up = quantizeHorizon(deg, 0.5, 'up');
  deg.forEach((d, i) => assert.ok(up[i] * 0.5 >= d));
});

test('windows: short gaps merge, short stretches vanish, edges are not merged', () => {
  const series = new Uint8Array(300);
  series.fill(1, 10, 60); // 50 min
  series.fill(1, 64, 100); // gap of 4 min -> merged: 10..100
  series.fill(1, 120, 140); // 20 min -> dropped
  series.fill(1, 160, 200); // 40 min
  series.fill(1, 206, 240); // gap of 6 min -> not merged
  const w = windowsFromSeries(series);
  assert.deepEqual(w, [{ start: 10, end: 100 }, { start: 160, end: 200 }, { start: 206, end: 240 }]);
  assert.deepEqual(windowsFromSeries(new Uint8Array(100)), []);
  assert.deepEqual(windowsFromSeries(new Uint8Array(100).fill(1)), [{ start: 0, end: 100 }]);
});

test('sun position sanity for Brussels', () => {
  // Local midnight UTC: summer solstice (CEST, UTC+2) and winter solstice (CET, UTC+1).
  const maxAlt = (utcMs: number) => Math.max(...sunDay(50.85, 4.35, utcMs).alt);
  const summer = maxAlt(Date.UTC(2026, 5, 21, -2));
  const winter = maxAlt(Date.UTC(2026, 11, 21, -1));
  assert.ok(Math.abs(summer - 62.6) < 0.5, `summer noon altitude ${summer}`);
  assert.ok(Math.abs(winter - 15.7) < 0.5, `winter noon altitude ${winter}`);
});
