'use client';

import { useEffect } from 'react';

/** Registers the offline/caching worker in production builds only (a worker in `next dev` would serve stale code). */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);
  return null;
}
