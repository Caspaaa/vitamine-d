import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import '../globals.css';
import { Providers } from '@/components/Providers';
import { ServiceWorker } from '@/components/ServiceWorker';
import { LOCALES, isLocale } from '@/i18n/config';

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

async function load(locale: string) {
  if (!isLocale(locale)) notFound();
  return (await import(`@/messages/${locale}.json`)).default as typeof import('@/messages/en.json');
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const m = await load(locale);
  return {
    title: m.app.title,
    description: m.app.description,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: m.app.name, statusBarStyle: 'default' },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#ffb703' };

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const messages = await load(locale);
  return (
    <html lang={locale}>
      <body>
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
        <ServiceWorker />
      </body>
    </html>
  );
}
