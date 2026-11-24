/** Time handling: UTC instants in, Europe/Brussels wall-clock time out (spec 6.5). No dependency beyond `Intl`. */

export const TIME_ZONE = 'Europe/Brussels';

/** A calendar day in the zone. `month` is 1-12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset of the zone from UTC at an instant, in minutes (60 in winter, 120 in summer for Brussels). */
export function zoneOffsetMinutes(ms: number, tz = TIME_ZONE): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function localDateOf(ms: number, tz = TIME_ZONE): LocalDate {
  const p = parts(ms, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** Wall-clock hour and minute at an instant. */
export function localClock(ms: number, tz = TIME_ZONE): { hour: number; minute: number } {
  const p = parts(ms, tz);
  return { hour: p.hour, minute: p.minute };
}

/**
 * UTC instant of a wall-clock time. A time that does not exist (spring-forward gap) moves forward by the gap;
 * a time that happens twice (autumn) resolves to the first occurrence.
 */
export function zonedTimeToUtc(d: LocalDate, hour: number, minute: number, tz = TIME_ZONE): number {
  const naive = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  let utc = naive - zoneOffsetMinutes(naive, tz) * 60000;
  // The offset at the first guess can differ from the offset at the result (near a transition): settle once more.
  const off = zoneOffsetMinutes(utc, tz);
  utc = naive - off * 60000;
  // Autumn overlap: prefer the earlier of the two instants that show the same wall time.
  const earlier = utc - 3600000;
  if (zoneOffsetMinutes(earlier, tz) * 60000 === naive - earlier) return earlier;
  return utc;
}

export function dayStartUtc(d: LocalDate, tz = TIME_ZONE): number {
  return zonedTimeToUtc(d, 0, 0, tz);
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Length of the local day in minutes: 1380 on the spring-forward day, 1500 on the autumn one. */
export function dayLengthMinutes(d: LocalDate, tz = TIME_ZONE): number {
  return Math.round((dayStartUtc(addDays(d, 1), tz) - dayStartUtc(d, tz)) / 60000);
}

export function sameDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2026-11-24` */
export function formatLocalDate(d: LocalDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** `2026-11-24T13:30`: the form used in URLs and `<input type="datetime-local">`, always Brussels wall time. */
export function formatLocalIso(ms: number, tz = TIME_ZONE): string {
  const d = localDateOf(ms, tz);
  const c = localClock(ms, tz);
  return `${formatLocalDate(d)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/** Inverse of `formatLocalIso`; returns null for anything that is not `YYYY-MM-DDTHH:mm`. */
export function parseLocalIso(text: string, tz = TIME_ZONE): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const back = new Date(Date.UTC(year, month - 1, day));
  if (back.getUTCMonth() !== month - 1) return null; // 31 February
  return zonedTimeToUtc({ year, month, day }, hour, minute, tz);
}
