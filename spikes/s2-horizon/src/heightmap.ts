import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../s1-shadow/web/src/png.ts';

const TILE = 256;

export interface HeightMap {
  /** Edge length in pixels. */
  size: number;
  /** Ground metres per pixel (true metres at the atlas centre latitude). */
  mpp: number;
  /** Surface (buildings + trees) and bare-ground elevations in metres, row-major, y down (south). */
  dsm: Float32Array;
  dtm: Float32Array;
  maxDsm: number;
  centre: { lat: number; lng: number };
  originMerc: [number, number];
  sizeMerc: number;
}

async function loadLayer(dir: string, size: number): Promise<{ data: Float32Array; meta: { zoom: number; x0: number; y0: number; tiles: number } }> {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const data = new Float32Array(size * size);
  for (let ty = 0; ty < meta.tiles; ty++) {
    for (let tx = 0; tx < meta.tiles; tx++) {
      const buf = readFileSync(join(dir, String(meta.zoom), String(meta.x0 + tx), `${meta.y0 + ty}.png`));
      const img = await decodePng(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      for (let y = 0; y < TILE; y++) {
        const row = (ty * TILE + y) * size + tx * TILE;
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 4;
          const v = (img.data[i] << 8) | img.data[i + 1];
          // value 0 = no LiDAR coverage
          data[row + x] = v === 0 ? NaN : v * meta.step - meta.offset;
        }
      }
    }
  }
  return { data, meta };
}

/** Loads the DSM and DTM tile sets written by spikes/s1-shadow/build_tiles.py (same grid). */
export async function loadHeightMap(root: string): Promise<HeightMap> {
  const m = JSON.parse(readFileSync(join(root, 'tiles', 'meta.json'), 'utf8'));
  const size = m.tiles * TILE;
  const [dsm, dtm] = await Promise.all([loadLayer(join(root, 'tiles'), size), loadLayer(join(root, 'tiles-dtm'), size)]);
  const n = 2 ** m.zoom;
  const originMerc: [number, number] = [m.x0 / n, m.y0 / n];
  const sizeMerc = m.tiles / n;
  const cx = originMerc[0] + sizeMerc / 2;
  const cy = originMerc[1] + sizeMerc / 2;
  const lng = cx * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI;
  let maxDsm = -Infinity;
  for (const v of dsm.data) if (v > maxDsm) maxDsm = v;
  return {
    size,
    mpp: (156543.03392804097 / n) * Math.cos((lat * Math.PI) / 180),
    dsm: dsm.data,
    dtm: dtm.data,
    maxDsm,
    centre: { lat, lng },
    originMerc,
    sizeMerc,
  };
}
