import { describe, expect, it } from 'vitest';
import { parseLocalIso } from '@vitamine/sun';
import { buildSearch, DEFAULT_VIEW, parseUrlState } from './urlState';

const view = { lng: 4.3725, lat: 50.8273, zoom: 17.25, pitch: 40, bearing: -20 };

describe('url state', () => {
  it('round-trips time and view', () => {
    const timeMs = parseLocalIso('2026-06-21T17:30');
    const parsed = parseUrlState(buildSearch(timeMs, view));
    expect(parsed.timeMs).toBe(timeMs);
    expect(parsed.view).toEqual(view);
  });

  it('does not write "now", so a shared link opens on the present', () => {
    const search = buildSearch(null, DEFAULT_VIEW);
    expect(new URLSearchParams(search).has('t')).toBe(false);
    expect(parseUrlState(search).timeMs).toBeNull();
  });

  it('keeps a flat north-up view out of the URL', () => {
    const q = new URLSearchParams(buildSearch(null, { ...view, pitch: 0, bearing: 0 }));
    expect(q.has('pitch')).toBe(false);
    expect(q.has('bearing')).toBe(false);
  });

  it('falls back to the default view when the position is invalid or outside Brussels', () => {
    for (const search of ['', '?lat=abc&lng=4.35', '?lat=48.85&lng=2.35', '?lat=50.84', '?lat=&lng=']) {
      const { view: v } = parseUrlState(search);
      expect([v.lat, v.lng]).toEqual([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng]);
    }
  });

  it('clamps zoom, pitch and bearing', () => {
    const { view: v } = parseUrlState('?lat=50.84&lng=4.35&z=99&pitch=200&bearing=900');
    expect([v.zoom, v.pitch, v.bearing]).toEqual([20, 70, 180]);
  });
});
