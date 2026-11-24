import type { Metadata, Viewport } from 'next';
import '../globals.css';

export const metadata: Metadata = { title: 'Vitamine D', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffb703' };

export default function RedirectLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
