import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Vitamine D',
    short_name: 'Vitamine D',
    description: 'Sun and shade in Brussels',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    background_color: '#fff8e6',
    theme_color: '#ffb703',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
