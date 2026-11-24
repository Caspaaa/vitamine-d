import { getPosition, getTimes } from 'suncalc';
import { TIME_ZONE, addDays, dayStartUtc, zoneOffsetMinutes, type LocalDate } from './time.ts';

/** Where the sun is, in the convention the shadow renderer uses. */
export interface SunState {
  /** Degrees clockwise from north (0 = N, 90 = E, 180 = S). */
  azimuthDeg: number;
  /** Degrees above the horizon, corrected for refraction (negative at night). */
  altitudeDeg: number;
}

export function sunPosition(ms: number, lat: number, lng: number): SunState {
  const p = getPosition(new Date(ms), lat, lng);
  return { azimuthDeg: p.azimuth, altitudeDeg: p.altitude };
}

export interface DaySun {
  /** UTC instants; null in polar day or night (not in Brussels, kept for correctness). */
  sunrise: number | null;
  sunset: number | null;
  solarNoon: number;
}

export function daySun(day: LocalDate, lat: number, lng: number, tz = TIME_ZONE): DaySun {
  const noon = dayStartUtc(day, tz) + 12 * 3600000;
  const t = getTimes(new Date(noon), lat, lng, 0, zoneOffsetMinutes(noon, tz));
  return { sunrise: t.sunrise ? t.sunrise.getTime() : null, sunset: t.sunset ? t.sunset.getTime() : null, solarNoon: t.solarNoon.getTime() };
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

const MIN = 60000;
const STEP_MIN = 5;
const roundDown = (ms: number) => Math.floor(ms / (STEP_MIN * MIN)) * STEP_MIN * MIN;
const roundUp = (ms: number) => Math.ceil(ms / (STEP_MIN * MIN)) * STEP_MIN * MIN;

/**
 * What the time scrubber covers on a day: sunrise to sunset with a little margin so the first and last minutes of sun
 * are reachable, rounded to 5 minutes and kept inside the local day. In polar day/night it falls back to the whole day.
 */
export function scrubberRange(day: LocalDate, lat: number, lng: number, tz = TIME_ZONE): TimeRange {
  const start = dayStartUtc(day, tz);
  const end = dayStartUtc(addDays(day, 1), tz);
  const s = daySun(day, lat, lng, tz);
  if (s.sunrise === null || s.sunset === null) return { startMs: start, endMs: end };
  return { startMs: Math.max(start, roundDown(s.sunrise - 20 * MIN)), endMs: Math.min(end, roundUp(s.sunset + 20 * MIN)) };
}

export function clampToRange(ms: number, r: TimeRange): number {
  return Math.min(r.endMs, Math.max(r.startMs, ms));
}
