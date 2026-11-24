import type { HeightMap } from './heightmap.ts';

export interface HorizonOptions {
  /** Azimuth samples around the full circle. */
  bins: number;
  /** Rays stop here: low-sun shadows longer than this are ignored (see S1: 500 m cap). */
  maxDistM: number;
  /** Observer height above the ground (DTM) in metres. */
  eyeM: number;
  /** Where the eye elevation comes from: bare ground (terraces) or the surface itself (to mimic the shadow renderer). */
  eyeFrom: 'dtm' | 'dsm';
  /** If the surface at the point is higher than the ground by more than this, the point is covered (tree, awning, roof). */
  coverM: number;
  /** Ray step in pixels near the point... */
  stepFine: number;
  /** ...growing by this fraction of the distance travelled (0 = constant step). */
  stepGrowth: number;
}

export const DEFAULT_HORIZON: HorizonOptions = {
  bins: 144,
  maxDistM: 500,
  eyeM: 1.0,
  eyeFrom: 'dtm',
  coverM: 2.5,
  stepFine: 0.5,
  stepGrowth: 0.02,
};

/**
 * Horizon elevation angle (degrees, clamped to 0..90) for each azimuth bin, seen from pixel position (px, py).
 * Bin i looks toward azimuth i * 360 / bins (0 = north, clockwise). Returns null where the data has no coverage.
 * A covered point (canopy, awning, roof above it) gets 90 in every bin: it never sees the sun.
 */
export function computeHorizon(hm: HeightMap, px: number, py: number, o: HorizonOptions = DEFAULT_HORIZON): Float32Array | null {
  const { size, dsm, dtm, mpp } = hm;
  const ix = Math.floor(px), iy = Math.floor(py);
  if (ix < 0 || iy < 0 || ix >= size || iy >= size) return null;
  const here = iy * size + ix;
  const ground = dtm[here];
  const surface = dsm[here];
  if (Number.isNaN(ground) || Number.isNaN(surface)) return null;

  const out = new Float32Array(o.bins);
  if (surface - ground > o.coverM) return out.fill(90);

  const eye = (o.eyeFrom === 'dtm' ? ground : surface) + o.eyeM;
  const maxS = o.maxDistM / mpp;
  const maxRise = hm.maxDsm - eye;

  for (let b = 0; b < o.bins; b++) {
    const az = (b * 2 * Math.PI) / o.bins;
    const dx = Math.sin(az), dy = -Math.cos(az);
    let best = 0; // slope (rise / run); the horizon never goes below 0
    let s = 1;
    while (s < maxS) {
      // Nothing left in the scene can be steeper than `best` from here on.
      if (maxRise / (s * mpp) <= best) break;
      const x = Math.floor(px + dx * s), y = Math.floor(py + dy * s);
      if (x < 0 || y < 0 || x >= size || y >= size) break;
      const slope = (dsm[y * size + x] - eye) / (s * mpp);
      if (slope > best) best = slope;
      s += Math.max(o.stepFine, s * o.stepGrowth);
    }
    out[b] = (Math.atan(best) * 180) / Math.PI;
  }
  return out;
}

/**
 * Exact sun test for one sun position, with no azimuth binning: marches along the sun direction with a small
 * constant step. Used as the reference the horizon profiles are measured against.
 */
export function isLitExact(
  hm: HeightMap, px: number, py: number, azDeg: number, altDeg: number,
  o: Pick<HorizonOptions, 'maxDistM' | 'eyeM' | 'eyeFrom' | 'coverM'>, step = 0.25,
): boolean | null {
  const { size, dsm, dtm, mpp } = hm;
  const ix = Math.floor(px), iy = Math.floor(py);
  if (ix < 0 || iy < 0 || ix >= size || iy >= size) return null;
  const here = iy * size + ix;
  const ground = dtm[here], surface = dsm[here];
  if (Number.isNaN(ground) || Number.isNaN(surface)) return null;
  if (altDeg <= 0) return false;
  if (surface - ground > o.coverM) return false;

  const eye = (o.eyeFrom === 'dtm' ? ground : surface) + o.eyeM;
  const t = Math.tan((altDeg * Math.PI) / 180);
  const az = (azDeg * Math.PI) / 180;
  const dx = Math.sin(az), dy = -Math.cos(az);
  const maxS = o.maxDistM / mpp;
  const maxRise = hm.maxDsm - eye;
  for (let s = 1; s < maxS; s += step) {
    if (maxRise / (s * mpp) <= t) break;
    const x = Math.floor(px + dx * s), y = Math.floor(py + dy * s);
    if (x < 0 || y < 0 || x >= size || y >= size) break;
    if ((dsm[y * size + x] - eye) / (s * mpp) >= t) return false;
  }
  return true;
}

// ---- storage: one byte per bin --------------------------------------------------------------------------------

export type Rounding = 'nearest' | 'up';

/** Quantises horizon degrees to bytes of `stepDeg` each (0.35 gives 255 levels over 0..90). */
export function quantizeHorizon(deg: Float32Array, stepDeg: number, rounding: Rounding = 'nearest'): Uint8Array {
  const q = new Uint8Array(deg.length);
  for (let i = 0; i < deg.length; i++) {
    const v = deg[i] / stepDeg;
    q[i] = Math.min(255, rounding === 'up' ? Math.ceil(v) : Math.round(v));
  }
  return q;
}

export type Interpolation = 'nearest' | 'linear' | 'max';

/** Horizon elevation (degrees) toward `azDeg`, from a quantised profile. */
export function lookupHorizon(q: ArrayLike<number>, stepDeg: number, azDeg: number, method: Interpolation = 'linear'): number {
  const n = q.length;
  const pos = (((azDeg % 360) + 360) % 360) / 360 * n;
  if (method === 'nearest') return q[Math.round(pos) % n] * stepDeg;
  const i0 = Math.floor(pos) % n;
  const i1 = (i0 + 1) % n;
  if (method === 'max') return Math.max(q[i0], q[i1]) * stepDeg;
  const f = pos - Math.floor(pos);
  return (q[i0] * (1 - f) + q[i1] * f) * stepDeg;
}
