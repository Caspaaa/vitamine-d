'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import type { ShadowStatus } from '@vitamine/shadow';
import { clampToRange, daySun, localClock, localDateOf, scrubberRange, sunPosition, zonedTimeToUtc, type LocalDate } from '@vitamine/sun';
import { LocaleSwitcher } from './LocaleSwitcher';
import type { MapHandle } from './MapView';
import { SearchBox } from './SearchBox';
import { TimePanel } from './TimePanel';
import { BRUSSELS_CENTER } from '@/lib/config';
import { insideBrussels, lastPosition, locate, rememberPosition } from '@/lib/geo';
import type { PlaceResult } from '@/lib/photon';
import { buildSearch, parseUrlState, type ViewState } from '@/lib/urlState';

const MapView = dynamic(() => import('./MapView'), { ssr: false });

const [LNG, LAT] = BRUSSELS_CENTER;
/** Simulated minutes per real second while the day plays. */
const PLAY_MIN_PER_SEC = 60;

export default function AppShell() {
  const t = useTranslations();
  const locale = useLocale();
  const initial = useMemo(() => parseUrlState(window.location.search), []);
  const [timeMs, setTimeMs] = useState(() => initial.timeMs ?? Date.now());
  const [live, setLive] = useState(initial.timeMs === null);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<ViewState>(initial.view);
  const [shadow, setShadow] = useState<ShadowStatus>({ state: 'loading', resident: 0, pending: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [fatal, setFatal] = useState(false);
  const mapRef = useRef<MapHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef(timeMs);
  timeRef.current = timeMs;

  const day: LocalDate = localDateOf(timeMs);
  const range = useMemo(() => scrubberRange(day, LAT, LNG), [day.year, day.month, day.day]); // eslint-disable-line react-hooks/exhaustive-deps
  const sunTimes = useMemo(() => daySun(day, LAT, LNG), [day.year, day.month, day.day]); // eslint-disable-line react-hooks/exhaustive-deps
  const sun = useMemo(() => sunPosition(timeMs, LAT, LNG), [timeMs]);

  // "Now" keeps following the clock until the user picks a time.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTimeMs(Date.now()), 15000);
    return () => clearInterval(id);
  }, [live]);

  // Play the day: a time-based loop, so the speed does not depend on the frame rate.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const next = timeRef.current + dt * PLAY_MIN_PER_SEC * 60;
      if (next >= range.endMs) {
        setTimeMs(range.endMs);
        setPlaying(false);
        return;
      }
      setTimeMs(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, range.endMs]);

  // Keep the address bar in step with the view and time, so reloading or sharing the link reproduces the screen.
  useEffect(() => {
    const id = setTimeout(() => window.history.replaceState(null, '', `${window.location.pathname}?${buildSearch(live ? null : timeMs, view)}`), 300);
    return () => clearTimeout(id);
  }, [timeMs, live, view]);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(id);
  }, [message]);

  const onTime = useCallback((ms: number) => {
    setLive(false);
    setPlaying(false);
    setTimeMs(ms);
  }, []);

  const onDate = useCallback(
    (d: LocalDate) => {
      const c = localClock(timeMs);
      const wanted = zonedTimeToUtc(d, c.hour, c.minute);
      setLive(false);
      setPlaying(false);
      setTimeMs(clampToRange(wanted, scrubberRange(d, LAT, LNG)));
    },
    [timeMs],
  );

  const onNow = useCallback(() => {
    setLive(true);
    setPlaying(false);
    setTimeMs(Date.now());
  }, []);

  const onLocate = useCallback(async () => {
    setLocating(true);
    setMessage(t('locate.locating'));
    try {
      const p = await locate();
      rememberPosition(p);
      mapRef.current?.setUserLocation(p);
      if (insideBrussels(p)) {
        setMessage(null);
        mapRef.current?.flyTo(p.lng, p.lat, 17);
      } else {
        setMessage(t('locate.outside'));
      }
    } catch (e) {
      setMessage(e === 'denied' ? t('locate.denied') : t('locate.unavailable'));
      searchRef.current?.focus();
    } finally {
      setLocating(false);
    }
  }, [t]);

  const onPick = useCallback((p: PlaceResult) => {
    mapRef.current?.setPin(p);
    mapRef.current?.flyTo(p.lng, p.lat, 17.5);
  }, []);

  const onReady = useCallback(() => {
    const last = lastPosition();
    if (last) mapRef.current?.setUserLocation(last);
  }, []);

  const chip =
    shadow.state === 'zoomed-out' ? t('map.zoomIn') : shadow.state === 'error' ? t('map.shadowsUnavailable') : shadow.state === 'loading' && shadow.pending > 0 ? t('map.loading') : null;

  return (
    <div className="flex h-dvh flex-col bg-sand" lang={locale}>
      <div className="relative min-h-0 flex-1">
        <MapView
          ref={mapRef}
          initialView={initial.view}
          sun={sun}
          onViewChange={setView}
          onShadowStatus={setShadow}
          onFatal={() => setFatal(true)}
          onReady={onReady}
          label={t('map.label')}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex gap-2">
            <SearchBox onPick={onPick} inputRef={searchRef} />
            <button
              type="button"
              onClick={onLocate}
              disabled={locating}
              aria-label={t('locate.label')}
              className="pointer-events-auto grid size-12 shrink-0 place-items-center rounded-full bg-white/95 text-blue-700 shadow-lg active:bg-sun/30 disabled:opacity-60"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={locating ? 'animate-pulse' : ''}>
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <LocaleSwitcher />
          </div>
          {message && (
            <p role="status" className="pointer-events-auto self-start rounded-2xl bg-white px-4 py-2 text-sm text-ink shadow-lg">
              {message}
            </p>
          )}
        </div>

        {chip && (
          <p role="status" className="pointer-events-none absolute inset-x-0 bottom-8 z-10 mx-auto w-fit max-w-[90%] rounded-full bg-ink/85 px-4 py-2 text-center text-sm text-white">
            {chip}
          </p>
        )}

        {fatal && (
          <div role="alert" className="absolute inset-0 z-20 grid place-items-center bg-sand p-8 text-center text-ink">
            <p className="max-w-sm text-lg">{t('map.error')}</p>
          </div>
        )}
      </div>

      <div className="z-10 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <TimePanel
          timeMs={timeMs}
          range={range}
          sunrise={sunTimes.sunrise}
          sunset={sunTimes.sunset}
          altitudeDeg={sun.altitudeDeg}
          live={live}
          playing={playing}
          onTime={onTime}
          onDate={onDate}
          onNow={onNow}
          onTogglePlay={() => setPlaying((p) => !p)}
        />
        <details className="mt-1 px-2 text-[11px] leading-snug text-ink/70">
          <summary className="cursor-pointer select-none py-1">ⓘ {t('map.dataLabel')}</summary>
          <p className="pb-1">{t('map.dataNote')}</p>
        </details>
      </div>
    </div>
  );
}
