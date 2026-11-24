/* Vitamine D service worker: offline app shell + caches for map and height tiles. __BUILD_ID__ and __DATA_URL__ are stamped at build time. */
const VERSION = '__BUILD_ID__';
const SHELL = `vd-shell-${VERSION}`;
const HEIGHT_TILES = 'vd-height-tiles-v1'; // paths are versioned (urbis-2021), so entries never go stale
const HEIGHT_INDEX = 'vd-height-index-v1'; // the tile list of that dataset; refreshed in the background, kept separate so tile trimming never evicts it
const MAP_TILES = 'vd-map-tiles-v1';
const LIMITS = { [HEIGHT_TILES]: 1200, [MAP_TILES]: 800 };
const DATA_BASE = new URL('__DATA_URL__', self.location.href).href.replace(/\/$/, '') + '/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('vd-shell-') && key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const extra = keys.length - LIMITS[name];
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]); // oldest first
}

async function cacheFirst(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    cache.put(request, res.clone()).then(() => (LIMITS[name] ? trim(name) : undefined));
  }
  return res;
}

async function staleWhileRevalidate(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone()).then(() => (LIMITS[name] ? trim(name) : undefined));
      return res;
    })
    .catch(() => hit);
  return hit || refresh;
}

async function networkFirst(request, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.url.startsWith(DATA_BASE)) {
    event.respondWith(url.pathname.endsWith('.png') ? cacheFirst(request, HEIGHT_TILES) : staleWhileRevalidate(request, HEIGHT_INDEX));
  } else if (url.hostname === 'tiles.openfreemap.org') {
    event.respondWith(staleWhileRevalidate(request, MAP_TILES));
  } else if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/_next/static/')) event.respondWith(cacheFirst(request, SHELL)); // content-hashed
    else if (request.mode === 'navigate') event.respondWith(networkFirst(request, SHELL));
    else event.respondWith(staleWhileRevalidate(request, SHELL));
  }
});
