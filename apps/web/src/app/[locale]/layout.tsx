import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Poppins } from 'next/font/google';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { type Locale } from '@ffc/i18n';
import { AnnouncementBanner } from '@/components/AnnouncementBanner';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { JsonLd } from '@/components/JsonLd';
import { WebVitals } from '@/components/WebVitals';
import { routing } from '@/i18n/routing';
import { organizationJsonLd, webSiteJsonLd } from '@/lib/jsonld';
import { SITE_NAMES, siteOrigin } from '@/lib/site';
import '../globals.css';

// Police auto-hébergée par next/font (docs/marque.md) : zéro requête
// externe, `swap` évite le texte invisible (CWV). Poids 400/500/600/700
// seulement — les titres/boutons majuscules n'ont pas besoin du reste.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
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
    icons: {
      icon: [
        { url: '/icons/maple-leaf.svg', type: 'image/svg+xml' },
        { url: '/icons/maple-leaf-32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: '/icons/maple-leaf-180.png',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#26a943',
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
    <html lang={locale} className={poppins.variable}>
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
          <AnnouncementBanner locale={locale as Locale} />
          <Header locale={locale as Locale} />
          <div id="contenu">{children}</div>
          <Footer locale={locale as Locale} />
          <WebVitals />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
