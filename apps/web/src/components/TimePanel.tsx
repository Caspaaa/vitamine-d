'use client';

import { useMemo, useRef } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { TIME_ZONE, formatLocalDate, localDateOf, type LocalDate, type TimeRange } from '@vitamine/sun';

interface Props {
  timeMs: number;
  range: TimeRange;
  sunrise: number | null;
  sunset: number | null;
  altitudeDeg: number;
  live: boolean;
  playing: boolean;
  onTime: (ms: number) => void;
  onDate: (d: LocalDate) => void;
  onNow: () => void;
  onTogglePlay: () => void;
}

export function TimePanel({ timeMs, range, sunrise, sunset, altitudeDeg, live, playing, onTime, onDate, onNow, onTogglePlay }: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const dateInput = useRef<HTMLInputElement>(null);

  const fmt = useMemo(
    () => ({
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE }),
      date: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: TIME_ZONE }),
    }),
    [locale],
  );

  const totalMin = Math.round((range.endMs - range.startMs) / 60000);
  const valueMin = Math.min(totalMin, Math.max(0, Math.round((timeMs - range.startMs) / 60000)));
  const night = altitudeDeg <= 0;
  const timeLabel = fmt.time.format(timeMs);

  const pickDate = (value: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) onDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  };

  return (
    <section aria-label={t('time.slider')} className="pointer-events-auto rounded-3xl bg-white/92 p-4 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        <output className="min-w-[4.2ch] text-3xl font-semibold tabular-nums text-ink">{timeLabel}</output>
        <label className="relative grid min-h-11 cursor-pointer place-items-center rounded-full bg-sun/25 px-4 text-sm font-medium text-ink active:bg-sun/40">
          <span>{fmt.date.format(timeMs)}</span>
          <input
            ref={dateInput}
            type="date"
            value={formatLocalDate(localDateOf(timeMs))}
            onChange={(e) => pickDate(e.target.value)}
            aria-label={t('time.date')}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onNow}
            aria-pressed={live}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${live ? 'bg-ink text-white' : 'bg-ink/10 text-ink active:bg-ink/20'}`}
          >
            {t('time.now')}
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? t('time.pause') : t('time.play')}
            className="grid size-11 place-items-center rounded-full bg-sun text-ink active:bg-sun-deep"
          >
            {playing ? (
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <rect x="3" y="2" width="4" height="14" rx="1" fill="currentColor" />
                <rect x="11" y="2" width="4" height="14" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M4 2.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L5.5 1.6A1 1 0 0 0 4 2.5z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={totalMin}
        step={1}
        value={valueMin}
        onChange={(e) => onTime(range.startMs + Number(e.target.value) * 60000)}
        aria-label={t('time.slider')}
        aria-valuetext={timeLabel}
        className="mt-3 block h-11 w-full cursor-pointer accent-sun-deep"
      />

      <div className="flex justify-between gap-2 text-xs text-ink/70">
        <span>{sunrise !== null && t('time.sunrise', { time: fmt.time.format(sunrise) })}</span>
        <span className="text-center">{night ? t('time.night') : t('time.sunAltitude', { altitude: Math.round(altitudeDeg) })}</span>
        <span className="text-right">{sunset !== null && t('time.sunset', { time: fmt.time.format(sunset) })}</span>
      </div>
    </section>
  );
}
