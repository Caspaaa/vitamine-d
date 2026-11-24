'use client';

import { useLocale, useTranslations } from 'use-intl';
import { LOCALES, LOCALE_NAMES, LOCALE_STORAGE_KEY, type Locale } from '@/i18n/config';

/**
 * Switching language is a navigation to the other locale's URL, keeping the time and the view.
 * The pill shows the two-letter code; the real <select> sits invisibly on top, so the native picker and screen-reader
 * behaviour stay intact.
 */
export function LocaleSwitcher() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  return (
    <div className="pointer-events-auto relative grid h-12 min-w-14 place-items-center rounded-full bg-white/95 px-3 text-sm font-semibold uppercase text-ink shadow-lg focus-within:ring-2 focus-within:ring-sun-deep">
      <span aria-hidden="true">{locale}</span>
      <select
        aria-label={t('locale.label')}
        value={locale}
        onChange={(e) => {
          const next = e.target.value as Locale;
          try {
            localStorage.setItem(LOCALE_STORAGE_KEY, next);
          } catch {
            /* private mode */
          }
          window.location.assign(`/${next}/${window.location.search}`);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
