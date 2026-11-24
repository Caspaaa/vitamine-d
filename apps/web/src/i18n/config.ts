export const LOCALES = ['fr', 'nl', 'en', 'de', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
/** Used when the browser's languages match none of ours. */
export const FALLBACK_LOCALE: Locale = 'en';

/** Names are shown in their own language, never translated. */
export const LOCALE_NAMES: Record<Locale, string> = { fr: 'Français', nl: 'Nederlands', en: 'English', de: 'Deutsch', es: 'Español' };

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** First of the browser's preferred languages that we support (`nl-BE` matches `nl`). */
export function negotiateLocale(languages: readonly string[]): Locale {
  for (const lang of languages) {
    const base = lang.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return FALLBACK_LOCALE;
}

export const LOCALE_STORAGE_KEY = 'vd-locale';
