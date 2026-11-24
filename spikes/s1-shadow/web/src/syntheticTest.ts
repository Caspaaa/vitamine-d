import { buildMaxMips, type HeightAtlas } from './atlas';
import { ShadowMask } from './shadowMask';
import { DEFAULT_PARAMS, ShadowProgram } from './shadowProgram';

const SIZE = 1024;
const MPP = 0.25; // metres per pixel for the synthetic world (finer than the real 0.75 m, to test the algorithm itself)
const STEP = 0.25;
const OFFSET = 10;
const GROUND = OFFSET / STEP; // quantised value of elevation 0 m

function makeAtlas(boxMetres: number, heightMetres: number): { atlas: HeightAtlas; x0: number; x1: number; y0: number; y1: number } {
  const level0 = new Uint16Array(SIZE * SIZE).fill(GROUND);
  const half = Math.round(boxMetres / MPP / 2);
  const x0 = SIZE / 2 - half, x1 = SIZE / 2 + half, y0 = SIZE / 2 - half, y1 = SIZE / 2 + half;
  const top = Math.round((heightMetres + OFFSET) / STEP);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) level0[y * SIZE + x] = top;
  const levels = buildMaxMips(level0, SIZE);
  const atlas: HeightAtlas = {
    size: SIZE, levels, maxValue: top, step: STEP, offset: OFFSET, metersPerPx: MPP,
    originMerc: [0, 0], sizeMerc: 1, centerLngLat: [0, 0], loadMs: { fetch: 0, decode: 0, mips: 0 },
  };
  return { atlas, x0, x1, y0, y1 };
}

let shared: { gl: WebGL2RenderingContext; program: ShadowProgram; mask: ShadowMask; atlas: HeightAtlas } | null = null;

function render(atlas: HeightAtlas, az: number, alt: number, algo: number, lodScale: number, bias: number): Uint8Array {
  if (!shared || shared.atlas !== atlas) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true })!;
    const program = new ShadowProgram(gl, atlas);
    shared = { gl, program, mask: new ShadowMask(gl, program), atlas };
  }
  const { gl, program, mask } = shared;
  gl.viewport(0, 0, SIZE, SIZE);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const m = new Float32Array([2 / SIZE, 0, 0, 0, 0, -2 / SIZE, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
  const params = { ...DEFAULT_PARAMS, azimuthDeg: az, altitudeDeg: alt, algo: algo >= 2 ? 1 : algo, lodScale, bias, biasRangeM: 6 };
  if (algo < 2) {
    program.draw(m, params);
  } else {
    const edge: [number, number] = algo === 4 ? [0.35, 0.65] : [0.45, 0.7];
    const opts = { smooth: algo >= 3, edge };
    // Force a recompute: the cache key only knows about sun and settings, and the edge doesn't matter for it.
    (mask as unknown as { key: string }).key = '';
    mask.update([0, 0, SIZE, SIZE], 1, params, opts);
    mask.composite(m, params, opts);
  }
  const out = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

const inShadow = (img: Uint8Array, x: number, y: number) => {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= SIZE || iy >= SIZE) return false;
  return img[((SIZE - 1 - iy) * SIZE + ix) * 4 + 3] > 64;
};

interface Row { algo: number; lodScale: number; bias: number; alt: number; az: number; expectedM: number; measuredM: number; errM: number }

function run(): { rows: Row[]; roofLit: boolean; groundLit: boolean; highSunClear: boolean; nightDark: boolean } {
  const H = 10;
  const { atlas, x0, x1, y0, y1 } = makeAtlas(20, H);
  const rows: Row[] = [];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let roofLit = true, groundLit = true;

  for (const [algo, lodScale, bias] of [[1, 16, 2], [2, 16, 2], [3, 16, 2], [4, 16, 2]]) {
    for (const alt of [10, 15, 20, 30, 45, 60]) {
      for (const az of [180, 90, 270, 0, 225, 135, 181, 179, 91, 89, 1, 359, 183, 3, 200, 160]) {
        const img = render(atlas, az, alt, algo, lodScale, bias);
        const r = (az * Math.PI) / 180;
        const dir = [Math.sin(r), -Math.cos(r)]; // pixel-space direction toward the sun
        const away = [-dir[0], -dir[1]];
        // March from the box centre along the shadow direction: this ray stays inside the shadow footprint for any
        // azimuth (a corner/edge-based scan would graze the footprint boundary for near-cardinal suns).
        // The shadow of the roof edge where the ray leaves the box lands exactly `H / tan(alt)` further on.
        const inBox = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
        let t = 0;
        while (inBox(cx + away[0] * t, cy + away[1] * t)) t += 0.02;
        const tExit = t;
        while (inShadow(img, cx + away[0] * t, cy + away[1] * t) && t < 900) t += 0.05;
        const measuredM = (t - tExit) * MPP;
        const expectedM = H / Math.tan((alt * Math.PI) / 180);
        rows.push({ algo, lodScale, bias, alt, az, expectedM, measuredM, errM: measuredM - expectedM });
        if (algo === 3 && bias === 2 && alt === 30 && az === 180) {
          roofLit = !inShadow(img, cx, cy) && !inShadow(img, cx - 10, cy + 10);
          groundLit = !inShadow(img, 100, 900) && !inShadow(img, cx, y1 + 30);
        }
      }
    }
  }
  const high = render(atlas, 180, 89, 3, 16, 2);
  const night = render(atlas, 180, -5, 3, 16, 2);
  return {
    rows, roofLit, groundLit,
    highSunClear: !inShadow(high, cx, y0 - 3) && !inShadow(high, cx, y1 + 3),
    nightDark: inShadow(night, 100, 100),
  };
}

const res = run();
const configs = [...new Set(res.rows.map((r) => `${r.algo}/${r.lodScale}/${r.bias}`))];
const summary = configs.map((c) => {
  const [algo, lodScale, bias] = c.split('/').map(Number);
  const rs = res.rows.filter((r) => r.algo === algo && r.lodScale === lodScale && r.bias === bias);
  const abs = rs.map((r) => Math.abs(r.errM));
  const worst = rs.reduce((w, r) => (Math.abs(r.errM) > Math.abs(w.errM) ? r : w));
  return {
    algo, lodScale, bias,
    maxAbsErrM: +Math.max(...abs).toFixed(2),
    meanAbsErrM: +(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(2),
    meanSignedErrM: +(rs.reduce((a, r) => a + r.errM, 0) / rs.length).toFixed(2),
    worst: `alt ${worst.alt} az ${worst.az}: ${worst.errM.toFixed(2)} m`,
  };
});
(window as unknown as { __results: unknown }).__results = { ...res, summary };
document.body.style.cssText = 'font:12px ui-monospace,monospace;white-space:pre;padding:12px';
document.body.textContent = [
  `roof lit: ${res.roofLit} | ground lit: ${res.groundLit} | sun 89° no shadow: ${res.highSunClear} | night dark: ${res.nightDark}`,
  ...summary.map((s) => JSON.stringify(s)),
].join('\n');
