import { describe, expect, it } from 'vitest';
import { clampToRange, daySun, scrubberRange, sunPosition } from './sun.ts';
import {
  addDays, dayLengthMinutes, dayStartUtc, formatLocalIso, localClock, localDateOf, parseLocalIso, zoneOffsetMinutes, zonedTimeToUtc,
} from './time.ts';

const BRUSSELS = { lat: 50.8467, lng: 4.3525 };
const utc = (iso: string) => Date.parse(iso);

describe('Brussels wall time', () => {
  it('knows the offset in winter and summer', () => {
    expect(zoneOffsetMinutes(utc('2026-01-15T12:00:00Z'))).toBe(60);
    expect(zoneOffsetMinutes(utc('2026-07-01T12:00:00Z'))).toBe(120);
  });

  it('has 23, 24 and 25 hour days around the clock changes', () => {
    expect(dayLengthMinutes({ year: 2026, month: 3, day: 29 })).toBe(23 * 60);
    expect(dayLengthMinutes({ year: 2026, month: 10, day: 25 })).toBe(25 * 60);
    expect(dayLengthMinutes({ year: 2026, month: 6, day: 21 })).toBe(24 * 60);
  });

  it('moves a time that does not exist (spring gap) forward and takes the first of a repeated time (autumn)', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 29 }, 2, 30)).toBe(utc('2026-03-29T01:30:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 25 }, 2, 30)).toBe(utc('2026-10-25T00:30:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 25 }, 4, 0)).toBe(utc('2026-10-25T03:00:00Z'));
  });

  it('starts local days at midnight Brussels time', () => {
    expect(dayStartUtc({ year: 2026, month: 6, day: 21 })).toBe(utc('2026-06-20T22:00:00Z'));
    expect(dayStartUtc({ year: 2026, month: 12, day: 21 })).toBe(utc('2026-12-20T23:00:00Z'));
  });

  it('adds days across month and year ends', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('round-trips the URL format and rejects junk', () => {
    const ms = utc('2026-07-01T11:30:00Z'); // 13:30 in Brussels
    expect(formatLocalIso(ms)).toBe('2026-07-01T13:30');
    expect(parseLocalIso('2026-07-01T13:30')).toBe(ms);
    expect(localClock(ms)).toEqual({ hour: 13, minute: 30 });
    expect(localDateOf(utc('2026-06-30T23:30:00Z'))).toEqual({ year: 2026, month: 7, day: 1 }); // after local midnight
    for (const bad of ['', 'now', '2026-02-31T10:00', '2026-13-01T10:00', '2026-01-01T25:00', '2026-01-01 10:00']) expect(parseLocalIso(bad)).toBeNull();
  });
});

// Reference: https://api.sunrise-sunset.org (lat 50.8467, lng 4.3525), fetched 2026-11-24. Different algorithm and
// rounding than suncalc, so the tolerance is two minutes.
const REFERENCE: [string, string, string][] = [
  ['2026-01-15', '2026-01-15T07:38:24Z', '2026-01-15T16:05:35Z'],
  ['2026-03-20', '2026-03-20T05:44:53Z', '2026-03-20T17:55:12Z'],
  ['2026-03-28', '2026-03-28T05:26:58Z', '2026-03-28T18:08:18Z'],
  ['2026-06-21', '2026-06-21T03:28:47Z', '2026-06-21T20:00:02Z'],
  ['2026-09-23', '2026-09-23T05:30:29Z', '2026-09-23T17:39:24Z'],
  ['2026-10-25', '2026-10-25T06:22:31Z', '2026-10-25T16:30:48Z'],
  ['2026-12-21', '2026-12-21T07:42:24Z', '2026-12-21T15:38:53Z'],
];

describe('sun', () => {
  it.each(REFERENCE)('sunrise and sunset on %s agree with the reference within 2 minutes', (date, rise, set) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const s = daySun({ year, month, day }, BRUSSELS.lat, BRUSSELS.lng);
    expect(Math.abs(s.sunrise! - utc(rise))).toBeLessThan(2 * 60000);
    expect(Math.abs(s.sunset! - utc(set))).toBeLessThan(2 * 60000);
  });

  it('reaches the expected noon altitude at the solstices and faces south at solar noon', () => {
    for (const [day, alt] of [[{ year: 2026, month: 6, day: 21 }, 62.6], [{ year: 2026, month: 12, day: 21 }, 15.7]] as const) {
      const noon = sunPosition(daySun(day, BRUSSELS.lat, BRUSSELS.lng).solarNoon, BRUSSELS.lat, BRUSSELS.lng);
      expect(noon.altitudeDeg).toBeCloseTo(alt, 0);
      expect(Math.abs(noon.azimuthDeg - 180)).toBeLessThan(0.5);
    }
  });

  it('puts the sun in the east in the morning, in the west in the evening and below the horizon at night', () => {
    expect(sunPosition(utc('2026-06-21T06:00:00Z'), BRUSSELS.lat, BRUSSELS.lng).azimuthDeg).toBeLessThan(180);
    expect(sunPosition(utc('2026-06-21T17:00:00Z'), BRUSSELS.lat, BRUSSELS.lng).azimuthDeg).toBeGreaterThan(180);
    expect(sunPosition(utc('2026-06-21T23:00:00Z'), BRUSSELS.lat, BRUSSELS.lng).altitudeDeg).toBeLessThan(0);
  });
});

describe('scrubber range', () => {
  it('covers sunrise to sunset with a margin, in 5 minute steps, inside the day', () => {
    const day = { year: 2026, month: 6, day: 21 };
    const r = scrubberRange(day, BRUSSELS.lat, BRUSSELS.lng);
    const s = daySun(day, BRUSSELS.lat, BRUSSELS.lng);
    expect(r.startMs).toBeLessThan(s.sunrise!);
    expect(r.endMs).toBeGreaterThan(s.sunset!);
    expect(s.sunrise! - r.startMs).toBeLessThanOrEqual(25 * 60000);
    expect(r.startMs % (5 * 60000)).toBe(0);
    expect(r.startMs).toBeGreaterThanOrEqual(dayStartUtc(day));
    expect(r.endMs).toBeLessThanOrEqual(dayStartUtc(addDays(day, 1)));
  });

  it('works on the clock-change days', () => {
    for (const day of [{ year: 2026, month: 3, day: 29 }, { year: 2026, month: 10, day: 25 }]) {
      const r = scrubberRange(day, BRUSSELS.lat, BRUSSELS.lng);
      expect(r.endMs).toBeGreaterThan(r.startMs + 8 * 3600000);
    }
  });

  it('clamps', () => {
    const r = { startMs: 100, endMs: 200 };
    expect([clampToRange(50, r), clampToRange(150, r), clampToRange(500, r)]).toEqual([100, 150, 200]);
  });
});
