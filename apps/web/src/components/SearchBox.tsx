'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import type { Locale } from '@/i18n/config';
import { searchPlaces, type PlaceResult } from '@/lib/photon';

interface Props {
  onPick: (place: PlaceResult) => void;
  /** Lets the parent move focus here (e.g. when the location is denied and an address is the way forward). */
  inputRef?: React.Ref<HTMLInputElement>;
}

type SearchState = 'idle' | 'loading' | 'done' | 'error';

export function SearchBox({ onPick, inputRef }: Props) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [state, setState] = useState<SearchState>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const picked = useRef('');

  // Debounced typeahead: one request per pause in typing, the previous one is cancelled.
  useEffect(() => {
    if (query === picked.current || query.trim().length < 3) {
      setResults([]);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    setState('loading');
    const timer = setTimeout(async () => {
      try {
        const found = await searchPlaces(query, locale, controller.signal);
        setResults(found);
        setState('done');
        setActive(-1);
        setOpen(true);
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, locale]);

  const choose = (r: PlaceResult) => {
    picked.current = r.title;
    setQuery(r.title);
    setOpen(false);
    setActive(-1);
    onPick(r);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
    } else if (e.key === 'Enter' && open && results.length) {
      e.preventDefault();
      choose(results[active >= 0 ? active : 0]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const status =
    state === 'loading' ? t('search.searching') : state === 'error' ? t('search.error') : state === 'done' ? (results.length ? t('search.results', { count: results.length }) : t('search.noResults')) : '';

  return (
    <div className="pointer-events-auto relative min-w-0 flex-1">
      <svg className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink/50" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="2" />
        <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => {
          picked.current = '';
          setQuery(e.target.value);
        }}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        enterKeyHint="search"
        className="h-12 w-full rounded-full bg-white/95 pl-11 pr-11 text-base text-ink shadow-lg outline-none ring-sun placeholder:text-ink/50 focus:ring-2"
      />
      {query && (
        <button
          type="button"
          aria-label={t('search.clear')}
          onClick={() => {
            picked.current = '';
            setQuery('');
            setResults([]);
            setOpen(false);
          }}
          className="absolute right-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full text-ink/60"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3 3 10 10M13 3 3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <ul id={listId} role="listbox" hidden={!open || results.length === 0} className="absolute left-0 right-0 top-14 max-h-72 overflow-auto rounded-2xl bg-white p-1 shadow-xl">
        {results.map((r, i) => (
          <li
            key={r.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(r)}
            className={`cursor-pointer rounded-xl px-3 py-2 ${i === active ? 'bg-sun/30' : 'active:bg-sun/20'}`}
          >
            <div className="truncate text-sm font-medium text-ink">{r.title}</div>
            {r.subtitle && <div className="truncate text-xs text-ink/60">{r.subtitle}</div>}
          </li>
        ))}
      </ul>
      <div aria-live="polite" className={state === 'error' ? 'absolute left-4 top-14 rounded-xl bg-white px-3 py-2 text-xs text-red-700 shadow' : 'sr-only'}>
        {status}
      </div>
    </div>
  );
}
