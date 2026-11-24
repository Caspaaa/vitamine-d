// GPU harness for the ring-buffer shadow engine (no MapLibre): synthetic world, real WebGL2, results in #out and window.__results.
import { HeightWindow } from '../src/heightWindow.ts';
import { ShadowMask } from '../src/shadowMask.ts';
import { DEFAULT_PARAMS, ShadowProgram, type ShadowParams } from '../src/shadowProgram.ts';
import { TileIndex, TileSource, type HeightTile } from '../src/tiles.ts';
import { chooseOrigin, type TileRect } from '../src/window.ts';

const X0 = 67100, Y0 = 43960, N = 32; // a 32 x 32 tile synthetic world over Brussels
const GROUND = 40; // 0 m: (0 + 10) / 0.25
const WALL = 80; // 10 m
const rows: Record<string, [number, number][]> = {};
for (let y = Y0; y < Y0 + N; y++) rows[String(y)] = [[X0, X0 + N - 1]];
const index = new TileIndex({ zoom: 17, tileSize: 256, offset: 10, step: 0.25, count: N * N, rows });

const WALL_TILE_X = 67119; // 67119 mod 16 = 15: the shadow of this wall crosses into slot 0
const WALL_TILE_Y = 43970;
const MARKER_TILE_X = 67113; // 67113 mod 16 = 9, the same slot as tile 67129
function synth(x: number, y: number): HeightTile {
  const level0 = new Uint16Array(65536).fill(GROUND);
  if (x === WALL_TILE_X) for (let py = 0; py < 256; py++) for (let px = 246; px < 252; px++) level0[py * 256 + px] = WALL; // 6 px thick, full height of the tile
  if (x === MARKER_TILE_X) for (let py = 100; py < 140; py++) for (let px = 100; px < 140; px++) level0[py * 256 + px] = WALL; // a 30 m block
  return { level0, maxValue: x === WALL_TILE_X || x === MARKER_TILE_X ? WALL : GROUND };
}

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 64;
const gl = canvas.getContext('webgl2')!;
const source = new TileSource(index, async (x, y) => synth(x, y), { cacheSize: 2000, concurrency: 64 });
const win = new HeightWindow(gl, source, () => undefined);
const program = new ShadowProgram(gl);
const mask = new ShadowMask(gl, program);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rect = (x0: number, y0: number, x1: number, y1: number): TileRect => ({ x0, y0, x1, y1 });

async function load(need: TileRect) {
  for (let i = 0; i < 400; i++) {
    win.update(need);
    win.pump(100000);
    if (!win.busy) return;
    await sleep(5);
  }
  throw new Error('tiles did not finish loading');
}

/** Mask of a world-pixel rectangle at full resolution. */
function maskOf(wx: number, wy: number, w: number, h: number, p: ShadowParams): { data: Uint8Array; w: number; h: number } {
  const [tx, ty] = win.origin!;
  mask.update(win, [wx - tx * 256, wy - ty * 256, w, h], 1, p);
  return { data: mask.debugReadRaw(), w, h };
}

const wallEastX = WALL_TILE_X * 256 + 252;
const wallMidY = WALL_TILE_Y * 256 + 128;
const sun = (az: number, alt: number): ShadowParams => ({ ...DEFAULT_PARAMS, azimuthDeg: az, altitudeDeg: alt });

/** Length in pixels of the shadow that starts at the east face of the wall, along the row `dy` below its middle. */
function shadowRunEast(m: { data: Uint8Array; w: number }, regionX: number, dy: number, regionY: number): number {
  const row = wallMidY + dy - regionY;
  let x = wallEastX - regionX;
  let n = 0;
  while (x < m.w && m.data[row * m.w + x] === 1) { n++; x++; }
  return n;
}

const results: Record<string, unknown> = {};
async function run() {
  const need1 = rect(67112, 43965, 67123, 43976);
  await load(need1);
  const origin1 = [...win.origin!];
  results.origin1 = origin1;
  const R = { x: wallEastX - 50, y: wallMidY - 30, w: 140, h: 60 };
  const mpp = win.metersPerPx;
  const expectedPx = 10 / Math.tan((30 * Math.PI) / 180) / mpp;
  const m1 = maskOf(R.x, R.y, R.w, R.h, sun(270, 30));
  const len1 = shadowRunEast(m1, R.x, 0, R.y);
  results.A_wall = { mpp, expectedPx, measuredPx: len1, errorPx: len1 - expectedPx, crossesSlotWrap: true };
  results.A_ok = Math.abs(len1 - expectedPx) <= 1.5;
  results.A_shadowPixels = m1.data.reduce((a, v) => a + v, 0);

  // B: shift the window by 4 tiles (slot clearing path) and recompute the same world rectangle.
  const need2 = rect(67116, 43965, 67127, 43976);
  await load(need2);
  const origin2 = [...win.origin!];
  results.origin2 = origin2;
  const m2 = maskOf(R.x, R.y, R.w, R.h, sun(270, 30));
  let diff = 0;
  for (let i = 0; i < m1.data.length; i++) if (m1.data[i] !== m2.data[i]) diff++;
  results.B_diffPixels = diff;
  results.B_ok = diff === 0 && origin1[0] !== origin2[0];

  // D: no ghosts. World tile 67129 reuses the slot of tile 67113 (which holds a 10 m block). It is inside the window
  // but outside the requested area, so it must read as empty: no shadow anywhere in it.
  const ghostX = 67129 * 256;
  const g = maskOf(ghostX, 43970 * 256, 256, 256, sun(270, 30));
  results.D_ghostPixels = g.data.reduce((a, v) => a + v, 0);
  results.D_ok = results.D_ghostPixels === 0;

  // C: jump far away (full reset), then come back: the wall must be rebuilt identically.
  await load(rect(67000, 43900, 67011, 43911));
  results.originFar = [...win.origin!];
  await load(need1);
  const m3 = maskOf(R.x, R.y, R.w, R.h, sun(270, 30));
  let diff3 = 0;
  for (let i = 0; i < m1.data.length; i++) if (m1.data[i] !== m3.data[i]) diff3++;
  results.C_diffPixels = diff3;
  results.C_ok = diff3 === 0;

  // E: other sun directions. Sun in the north (az 0) casts a shadow to the south: a wall running north-south casts none
  // beyond its own thickness, so the long shadow is only visible for sun in the east/west. Check east (az 90): shadow to the west.
  const m4 = maskOf(R.x, R.y, R.w, R.h, sun(90, 30));
  let west = 0;
  let x = wallEastX - 6 - R.x - 1;
  const rowIdx = wallMidY - R.y;
  while (x >= 0 && m4.data[rowIdx * R.w + x] === 1) { west++; x--; }
  results.E_westPx = west;
  results.E_ok = Math.abs(west - expectedPx) <= 1.5;

  // F: night: everything with data is in shade.
  const m5 = maskOf(R.x, R.y, R.w, R.h, sun(180, -5));
  results.F_nightAllShade = m5.data.every((v) => v === 1);

  results.ALL_OK = [results.A_ok, results.B_ok, results.C_ok, results.D_ok, results.E_ok, results.F_nightAllShade].every(Boolean);
}

run().then(
  () => finish(),
  (e) => { results.error = String(e); finish(); },
);
function finish() {
  (window as unknown as { __results: unknown }).__results = results;
  document.getElementById('out')!.textContent = JSON.stringify(results, null, 2);
}
