import { getPosition } from 'suncalc';

export interface SunState {
  azimuth: number;
  altitude: number;
}

export function sunAt(date: Date, lat: number, lng: number): SunState {
  const p = getPosition(date, lat, lng);
  return { azimuth: p.azimuth, altitude: p.altitude };
}

/** Build a Date from a yyyy-mm-dd string and minutes after local midnight (browser time zone). */
export function localDate(day: string, minutes: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

export function todayString(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
