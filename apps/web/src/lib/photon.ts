import { BRUSSELS_BOUNDS, SEARCH_URL } from './config';
import type { Locale } from '@/i18n/config';

export interface PlaceResult {
  id: string;
  title: string;
  subtitle: string;
  lng: number;
  lat: number;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { osm_id?: number; osm_type?: string; name?: string; street?: string; housenumber?: string; postcode?: string; city?: string; district?: string; locality?: string; county?: string };
}

/** Photon answers in these languages only; for the others it returns local names. */
const PHOTON_LANG: Partial<Record<Locale, string>> = { fr: 'fr', en: 'en', de: 'de' };

const cache = new Map<string, PlaceResult[]>();

export function describe(f: PhotonFeature): PlaceResult {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const title = p.name || street || p.locality || p.district || '';
  const place = p.city || p.county || '';
  const subtitle = [p.name && street ? street : '', [p.postcode, place].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    id: `${p.osm_type ?? ''}${p.osm_id ?? ''}:${f.geometry.coordinates.join(',')}`,
    title,
    subtitle,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  };
}

/**
 * Typeahead on the public Photon instance (spec: Nominatim forbids autocomplete). Callers must debounce; results are
 * cached for the session and restricted to Brussels. Throws on network errors, resolves [] when nothing matches.
 */
export async function searchPlaces(query: string, locale: Locale, signal?: AbortSignal): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const key = `${locale}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '6');
  url.searchParams.set('bbox', `${BRUSSELS_BOUNDS[0][0]},${BRUSSELS_BOUNDS[0][1]},${BRUSSELS_BOUNDS[1][0]},${BRUSSELS_BOUNDS[1][1]}`);
  const lang = PHOTON_LANG[locale];
  if (lang) url.searchParams.set('lang', lang);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const json = (await r.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  const results = (json.features ?? []).map(describe).filter((x) => x.title && !seen.has(x.title + x.subtitle) && seen.add(x.title + x.subtitle));
  cache.set(key, results);
  if (cache.size > 60) cache.delete(cache.keys().next().value!);
  return results;
}
