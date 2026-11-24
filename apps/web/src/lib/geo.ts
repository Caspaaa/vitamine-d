import { BRUSSELS_BOUNDS } from './config';

export type LocateError = 'denied' | 'unavailable';

export interface Position {
  lng: number;
  lat: number;
  /** Metres. */
  accuracy: number;
}

const STORAGE_KEY = 'vd-last-position';

/** Asks the browser once. The position stays on the device (spec: it never leaves it). */
export function locate(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject('unavailable' satisfies LocateError);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy }),
      (e) => reject((e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable') satisfies LocateError),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  });
}

export function insideBrussels(p: { lng: number; lat: number }): boolean {
  return p.lng >= BRUSSELS_BOUNDS[0][0] && p.lng <= BRUSSELS_BOUNDS[1][0] && p.lat >= BRUSSELS_BOUNDS[0][1] && p.lat <= BRUSSELS_BOUNDS[1][1];
}

export function rememberPosition(p: Position): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    /* private mode: nothing to remember */
  }
}

export function lastPosition(): Position | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Position | null;
    return v && Number.isFinite(v.lng) && Number.isFinite(v.lat) ? v : null;
  } catch {
    return null;
  }
}
