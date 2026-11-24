import { formatLocalIso, parseLocalIso } from '@vitamine/sun';
import { BRUSSELS_CENTER, DEFAULT_ZOOM, MAX_BOUNDS } from './config';

export interface ViewState {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export const DEFAULT_VIEW: ViewState = { lng: BRUSSELS_CENTER[0], lat: BRUSSELS_CENTER[1], zoom: DEFAULT_ZOOM, pitch: 0, bearing: 0 };

export interface UrlState {
  /** null = "now" (the clock keeps running). */
  timeMs: number | null;
  view: ViewState;
}

const finite = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Reads `?t=2026-06-21T17:30&lat=50.84&lng=4.35&z=16.5&pitch=40&bearing=20`; anything invalid falls back to the default. */
export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const t = q.get('t');
  const lng = finite(q.get('lng'));
  const lat = finite(q.get('lat'));
  const inside = lng !== null && lat !== null && lng >= MAX_BOUNDS[0][0] && lng <= MAX_BOUNDS[1][0] && lat >= MAX_BOUNDS[0][1] && lat <= MAX_BOUNDS[1][1];
  const zoom = finite(q.get('z'));
  return {
    timeMs: t ? parseLocalIso(t) : null,
    view: {
      lng: inside ? lng : DEFAULT_VIEW.lng,
      lat: inside ? lat : DEFAULT_VIEW.lat,
      zoom: zoom === null ? DEFAULT_VIEW.zoom : clamp(zoom, 10, 20),
      pitch: clamp(finite(q.get('pitch')) ?? 0, 0, 70),
      bearing: clamp(finite(q.get('bearing')) ?? 0, -180, 180),
    },
  };
}

/** Inverse of `parseUrlState`. "Now" is not written, so a shared link without a time always opens on the present. */
export function buildSearch(timeMs: number | null, view: ViewState): string {
  const q = new URLSearchParams();
  if (timeMs !== null) q.set('t', formatLocalIso(timeMs));
  q.set('lat', view.lat.toFixed(5));
  q.set('lng', view.lng.toFixed(5));
  q.set('z', view.zoom.toFixed(2));
  if (Math.abs(view.pitch) > 0.5) q.set('pitch', view.pitch.toFixed(0));
  if (Math.abs(view.bearing) > 0.5) q.set('bearing', view.bearing.toFixed(0));
  return q.toString();
}
