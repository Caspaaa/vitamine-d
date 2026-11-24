'use client';

import dynamic from 'next/dynamic';
import { Splash } from './Splash';

/** The map needs the browser (WebGL, geolocation, the address bar), so the app shell is rendered on the client only. */
const AppShell = dynamic(() => import('./AppShell'), { ssr: false, loading: () => <Splash /> });

export default function ClientApp() {
  return <AppShell />;
}
