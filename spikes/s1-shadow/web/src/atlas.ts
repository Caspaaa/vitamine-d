import { decodePng } from './png';

export interface AtlasMeta {
  zoom: number;
  x0: number;
  y0: number;
  tiles: number;
  offset: number;
  step: number;
}

export interface HeightAtlas {
  /** Edge length in pixels (power of two). */
  size: number;
  /** levels[0] = full resolution; levels[k] = max over 2^k x 2^k blocks. Values are quantised elevations. */
  levels: Uint16Array[];
  maxValue: number;
  /** Quantisation: elevation_m = value * step - offset. */
  step: number;
  offset: number;
  /** Ground metres per pixel (true metres, not web-mercator metres). */
  metersPerPx: number;
  /** North-west corner and width of the atlas in normalised web-mercator coordinates (0..1). */
  originMerc: [number, number];
  sizeMerc: number;
  centerLngLat: [number, number];
  loadMs: { fetch: number; decode: number; mips: number };
}

const TILE_PX = 256;

/** Legacy decode through a 2D canvas. Brave's fingerprinting protection corrupts these reads. */
async function decodeViaCanvas(buffer: ArrayBuffer): Promise<Uint8ClampedArray> {
  const ctx = new OffscreenCanvas(TILE_PX, TILE_PX).getContext('2d', { willReadFrequently: true })!;
  const bmp = await createImageBitmap(new Blob([buffer]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
}
export const MAX_LOD = 7;

export function buildMaxMips(level0: Uint16Array, size: number): Uint16Array[] {
  const levels = [level0];
  let prev = level0;
  let prevSize = size;
  for (let l = 1; l <= MAX_LOD; l++) {
    const s = prevSize >> 1;
    const cur = new Uint16Array(s * s);
    for (let y = 0; y < s; y++) {
      const r0 = 2 * y * prevSize;
      const r1 = r0 + prevSize;
      for (let x = 0; x < s; x++) {
        const a = prev[r0 + 2 * x];
        const b = prev[r0 + 2 * x + 1];
        const c = prev[r1 + 2 * x];
        const d = prev[r1 + 2 * x + 1];
        cur[y * s + x] = Math.max(a, b, c, d);
      }
    }
    levels.push(cur);
    prev = cur;
    prevSize = s;
  }
  return levels;
}

function mercToLngLat(x: number, y: number): [number, number] {
  const lng = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lng, lat];
}

export type TileDecoder = 'png' | 'canvas';

/**
 * Stitch the z/x/y height tiles into one atlas and build the max-reduced mip chain.
 * `decoder: 'canvas'` is the old canvas-based path, kept only to demonstrate the Brave problem (see png.ts).
 */
export async function loadAtlas(base = '/tiles', concurrency = 16, decoder: TileDecoder = 'png'): Promise<HeightAtlas> {
  const meta: AtlasMeta = await (await fetch(`${base}/meta.json`)).json();
  const size = meta.tiles * TILE_PX;
  const level0 = new Uint16Array(size * size);

  const jobs: [number, number][] = [];
  for (let ty = 0; ty < meta.tiles; ty++) for (let tx = 0; tx < meta.tiles; tx++) jobs.push([tx, ty]);

  let fetchMs = 0;
  let decodeMs = 0;
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      const f0 = performance.now();
      const buffer = await (await fetch(`${base}/${meta.zoom}/${meta.x0 + tx}/${meta.y0 + ty}.png`)).arrayBuffer();
      const f1 = performance.now();
      const px = decoder === 'png' ? (await decodePng(buffer)).data : await decodeViaCanvas(buffer);
      for (let y = 0; y < TILE_PX; y++) {
        const dst = (ty * TILE_PX + y) * size + tx * TILE_PX;
        for (let x = 0; x < TILE_PX; x++) {
          const i = (y * TILE_PX + x) * 4;
          level0[dst + x] = (px[i] << 8) | px[i + 1];
        }
      }
      fetchMs += f1 - f0;
      decodeMs += performance.now() - f1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const m0 = performance.now();
  const levels = buildMaxMips(level0, size);
  const mipsMs = performance.now() - m0;

  const n = 2 ** meta.zoom;
  const originMerc: [number, number] = [meta.x0 / n, meta.y0 / n];
  const sizeMerc = meta.tiles / n;
  const centerLngLat = mercToLngLat(originMerc[0] + sizeMerc / 2, originMerc[1] + sizeMerc / 2);
  const metersPerPx = (156543.03392804097 / n) * Math.cos((centerLngLat[1] * Math.PI) / 180);

  return {
    size,
    levels,
    maxValue: levels[MAX_LOD].reduce((m, v) => (v > m ? v : m), 0),
    step: meta.step,
    offset: meta.offset,
    metersPerPx,
    originMerc,
    sizeMerc,
    centerLngLat,
    loadMs: { fetch: fetchMs / concurrency, decode: decodeMs / concurrency, mips: mipsMs },
  };
}

/** Elevation in metres at an atlas pixel (CPU side, for debugging/tests). */
export function elevationAt(atlas: HeightAtlas, px: number, py: number): number {
  return atlas.levels[0][py * atlas.size + px] * atlas.step - atlas.offset;
}
