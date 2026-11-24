import { getPosition } from 'suncalc';
import { lookupHorizon, type Interpolation } from './horizon.ts';

/** Sun positions for one local day at 1-minute resolution, from a UTC instant that is local midnight. */
export interface SunDay {
  startMs: number;
  /** Degrees; azimuth clockwise from north. One entry per minute. */
  az: Float32Array;
  alt: Float32Array;
}

export function sunDay(lat: number, lng: number, localMidnightUtcMs: number, minutes = 1440): SunDay {
  const az = new Float32Array(minutes);
  const alt = new Float32Array(minutes);
  for (let m = 0; m < minutes; m++) {
    const p = getPosition(new Date(localMidnightUtcMs + m * 60_000), lat, lng);
    az[m] = p.azimuth;
    alt[m] = p.altitude;
  }
  return { startMs: localMidnightUtcMs, az, alt };
}

export interface WindowConfig {
  /** Share of the terrace's sample points that must be lit for the terrace to count as sunny. */
  litFraction: number;
  /** Hysteresis: once sunny, stay sunny until the lit share drops below this (default: same as litFraction). */
  litFractionOff?: number;
  /** A sunny stretch shorter than this is not reported. */
  minWindowMin: number;
  /** A shaded gap of at most this many minutes inside a sunny stretch is ignored (a chimney is not an interruption). */
  mergeGapMin: number;
}

export const DEFAULT_WINDOWS: WindowConfig = { litFraction: 0.5, minWindowMin: 30, mergeGapMin: 5 };

export interface SunWindow {
  /** Minutes after local midnight; `end` is exclusive. */
  start: number;
  end: number;
}

/** Turns a per-minute "is sunny" series into windows: merge short gaps, drop short stretches. */
export function windowsFromSeries(sunny: ArrayLike<boolean | number>, cfg: WindowConfig = DEFAULT_WINDOWS): SunWindow[] {
  const n = sunny.length;
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = sunny[i] ? 1 : 0;

  // Fill short gaps that sit between two sunny minutes.
  let i = 0;
  while (i < n) {
    if (filled[i]) { i++; continue; }
    let j = i;
    while (j < n && !filled[j]) j++;
    if (i > 0 && j < n && j - i <= cfg.mergeGapMin) for (let k = i; k < j; k++) filled[k] = 1;
    i = j;
  }

  const out: SunWindow[] = [];
  i = 0;
  while (i < n) {
    if (!filled[i]) { i++; continue; }
    let j = i;
    while (j < n && filled[j]) j++;
    if (j - i >= cfg.minWindowMin) out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

export interface TerraceProfiles {
  /** One quantised horizon profile per sample point of the terrace. */
  points: Uint8Array[];
}

/**
 * Share of the terrace's sample points that are lit, for every minute of the day.
 * Minutes with the sun below the horizon are 0.
 */
export function litFractionSeries(
  t: TerraceProfiles, stepDeg: number, sun: SunDay, method: Interpolation = 'linear',
): Float32Array {
  const n = sun.az.length;
  const out = new Float32Array(n);
  const np = t.points.length;
  for (let m = 0; m < n; m++) {
    const alt = sun.alt[m];
    if (alt <= 0) continue;
    let lit = 0;
    for (let p = 0; p < np; p++) if (alt > lookupHorizon(t.points[p], stepDeg, sun.az[m], method)) lit++;
    out[m] = lit / np;
  }
  return out;
}

export function sunnyMinutes(fraction: Float32Array, cfg: WindowConfig = DEFAULT_WINDOWS): Uint8Array {
  const on = cfg.litFraction;
  const off = cfg.litFractionOff ?? on;
  const out = new Uint8Array(fraction.length);
  let sunny = false;
  for (let i = 0; i < fraction.length; i++) {
    const f = fraction[i];
    sunny = sunny ? f >= off && f > 0 : f >= on && f > 0;
    out[i] = sunny ? 1 : 0;
  }
  return out;
}

export function sunWindows(
  t: TerraceProfiles, stepDeg: number, sun: SunDay, method: Interpolation = 'linear', cfg: WindowConfig = DEFAULT_WINDOWS,
): SunWindow[] {
  return windowsFromSeries(sunnyMinutes(litFractionSeries(t, stepDeg, sun, method), cfg), cfg);
}
