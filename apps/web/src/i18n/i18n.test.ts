import { describe, expect, it } from 'vitest';
import { FALLBACK_LOCALE, LOCALES, negotiateLocale } from './config';
import de from '../messages/de.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import fr from '../messages/fr.json';
import nl from '../messages/nl.json';

const catalogs = { de, en, es, fr, nl } satisfies Record<(typeof LOCALES)[number], unknown>;

/** `{ "map": { "zoomIn": "…" } }` → `{ "map.zoomIn": "…" }` */
function flatten(node: unknown, prefix = ''): Record<string, string> {
  if (typeof node === 'string') return { [prefix]: node };
  return Object.entries(node as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [k, v]) => ({ ...acc, ...flatten(v, prefix ? `${prefix}.${k}` : k) }),
    {},
  );
}

/** Names of the ICU arguments a message uses: `{count, plural, …}` → `count`. */
const placeholders = (message: string) => [...new Set([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]!))].sort();

const reference = flatten(en);

describe('message catalogs', () => {
  it('covers every supported language', () => {
    expect(Object.keys(catalogs).sort()).toEqual([...LOCALES].sort());
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      const messages = flatten(catalogs[locale]);

      it('has exactly the keys of the English catalog', () => {
        expect(Object.keys(messages).sort()).toEqual(Object.keys(reference).sort());
      });

      it('has no empty message', () => {
        expect(Object.entries(messages).filter(([, v]) => v.trim() === '')).toEqual([]);
      });

      it('uses the same placeholders as English', () => {
        for (const [key, message] of Object.entries(messages)) expect(placeholders(message), key).toEqual(placeholders(reference[key]!));
      });
    });
  }
});

describe('negotiateLocale', () => {
  it('matches regional variants and respects the browser preference order', () => {
    expect(negotiateLocale(['nl-BE', 'fr'])).toBe('nl');
    expect(negotiateLocale(['it', 'DE-ch', 'en'])).toBe('de');
  });

  it('falls back when nothing matches', () => {
    expect(negotiateLocale(['it', 'pt-BR'])).toBe(FALLBACK_LOCALE);
    expect(negotiateLocale([])).toBe(FALLBACK_LOCALE);
  });
});
