import type { Metadata } from 'next';
import { type Locale } from '@ffc/i18n';
import { absoluteUrl, type LocalizedHref, SITE_NAMES } from './site';

/**
 * Métadonnées SEO d'une page : canonical + hreflang inter-domaines.
 *
 * `hrefs` donne le href INTERNE de la page dans chaque locale — pour les
 * fiches produit les slugs diffèrent (slugs localisés de l'API), d'où un
 * href par locale. Une locale absente (traduction manquante) n'émet pas
 * d'alternate. `x-default` pointe vers l'anglais (audience internationale).
 */
export interface PageSeo {
  locale: Locale;
  hrefs: Partial<Record<Locale, LocalizedHref>>;
  title: string;
  description?: string;
  /** Pages à ne pas indexer (recherche, listes filtrées). */
  noindex?: boolean;
  /** Images OpenGraph (URL absolues). */
  images?: string[];
}

const OG_LOCALES: Record<Locale, string> = { fr: 'fr_CA', en: 'en_CA' };
const HREFLANG: Record<Locale, string> = { fr: 'fr-CA', en: 'en-CA' };

export function pageMetadata(seo: PageSeo): Metadata {
  const { locale, hrefs, title, description, noindex, images } = seo;

  const currentHref = hrefs[locale];
  const canonical = currentHref ? absoluteUrl(locale, currentHref) : undefined;

  const languages: Record<string, string> = {};
  for (const l of ['fr', 'en'] as const) {
    const href = hrefs[l];
    if (href) languages[HREFLANG[l]] = absoluteUrl(l, href);
  }
  if (hrefs.en) languages['x-default'] = absoluteUrl('en', hrefs.en);

  return {
    title,
    description,
    alternates: canonical ? { canonical, languages } : undefined,
    robots: noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      title,
      description,
      siteName: SITE_NAMES[locale],
      locale: OG_LOCALES[locale],
      type: 'website',
      url: canonical,
      images,
    },
  };
}
