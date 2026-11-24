'use client';

import { useEffect } from 'react';
import { Splash } from '@/components/Splash';
import { LOCALES, LOCALE_NAMES, LOCALE_STORAGE_KEY, isLocale, negotiateLocale } from '@/i18n/config';

/** "/" has no content: it sends the visitor to the saved language, else the browser's, else English. */
export default function Root() {
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      /* private mode */
    }
    const locale = isLocale(saved) ? saved : negotiateLocale(navigator.languages ?? [navigator.language]);
    window.location.replace(`/${locale}/${window.location.search}`);
  }, []);
  return (
    <>
      <Splash />
      <noscript>
        <nav className="p-6 text-center">
          {LOCALES.map((l) => (
            <a key={l} href={`/${l}/`} className="mx-3 underline">
              {LOCALE_NAMES[l]}
            </a>
          ))}
        </nav>
      </noscript>
    </>
  );
}
