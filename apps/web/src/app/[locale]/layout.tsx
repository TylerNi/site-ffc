import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { type Locale } from '@ffc/i18n';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { JsonLd } from '@/components/JsonLd';
import { WebVitals } from '@/components/WebVitals';
import { routing } from '@/i18n/routing';
import { organizationJsonLd, webSiteJsonLd } from '@/lib/jsonld';
import { SITE_NAMES, siteOrigin } from '@/lib/site';
import '../globals.css';

// Police variable auto-hébergée par next/font : zéro requête externe,
// `swap` évite le texte invisible (CWV).
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const siteName = SITE_NAMES[locale];

  return {
    metadataBase: new URL(siteOrigin(locale)),
    title: { default: siteName, template: `%s · ${siteName}` },
    applicationName: siteName,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0e5e96',
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations({ locale: locale as Locale, namespace: 'web.a11y' });

  return (
    <html lang={locale} className={inter.variable}>
      <body>
        {/* `messages={null}` : seuls la locale et la config passent au client
            (les liens localisés en ont besoin). Les composants clients
            reçoivent leurs libellés en props — aucun dictionnaire ne voyage. */}
        <NextIntlClientProvider messages={null}>
          <JsonLd data={organizationJsonLd(locale as Locale)} />
          <JsonLd data={webSiteJsonLd(locale as Locale)} />
          <a className="skip-link" href="#contenu">
            {t('skipToContent')}
          </a>
          <Header locale={locale as Locale} />
          <div id="contenu">{children}</div>
          <Footer locale={locale as Locale} />
          <WebVitals />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
