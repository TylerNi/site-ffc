import { type Locale } from '@ffc/i18n';
import { type ProductDetail } from './api';
import { jsonLdPrice } from './format';
import { absoluteUrl, SITE_NAMES, siteOrigin } from './site';

/**
 * Données structurées schema.org (JSON-LD) — builders PURS et testés.
 * Références : Product/AggregateOffer (fiches riches), BreadcrumbList,
 * WebSite + SearchAction (sitelinks searchbox), Organization.
 */

type JsonLdObject = Record<string, unknown>;

export function organizationJsonLd(locale: Locale): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAMES[locale],
    url: siteOrigin(locale),
    logo: `${siteOrigin(locale)}/icon.svg`,
    // Les deux vitrines sont la même entreprise — lier les domaines.
    sameAs: [siteOrigin(locale === 'fr' ? 'en' : 'fr')],
  };
}

export function webSiteJsonLd(locale: Locale): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAMES[locale],
    url: siteOrigin(locale),
    inLanguage: locale === 'fr' ? 'fr-CA' : 'en-CA',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${absoluteUrl(locale, '/search')}?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

/** Fil d'Ariane — le dernier élément (page courante) ne porte pas d'URL. */
export function breadcrumbJsonLd(items: Array<{ name: string; url?: string }>): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}

/**
 * Fiche produit : offres agrégées sur les variantes actives, disponibilité,
 * note moyenne seulement s'il y a des avis (une note à 0 sans avis est un
 * signal invalide pour les fiches riches).
 */
export function productJsonLd(params: {
  product: ProductDetail;
  url: string;
  locale: Locale;
  imageUrls?: string[];
}): JsonLdObject {
  const { product, url, locale, imageUrls = [] } = params;
  const prices = product.variants.map((v) => v.priceCents);
  const inStock = product.variants.some((v) => v.inStock);
  const currency = product.variants[0]?.currency ?? 'CAD';

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.metaDescription ?? product.shortDescription ?? undefined,
    sku: product.variants[0]?.sku,
    brand: { '@type': 'Brand', name: product.brand.name },
    ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
    ...(product.reviews.count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: product.reviews.average,
            reviewCount: product.reviews.count,
          },
        }
      : {}),
    offers: {
      '@type': 'AggregateOffer',
      url,
      priceCurrency: currency,
      lowPrice: prices.length ? jsonLdPrice(Math.min(...prices)) : undefined,
      highPrice: prices.length ? jsonLdPrice(Math.max(...prices)) : undefined,
      offerCount: product.variants.length,
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
    inLanguage: locale === 'fr' ? 'fr-CA' : 'en-CA',
  };
}

/** Sérialisation sûre pour <script> : échappe `<` (anti-XSS standard). */
export function serializeJsonLd(data: JsonLdObject): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
