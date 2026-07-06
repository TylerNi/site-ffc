import { describe, expect, it } from 'vitest';
import { type ProductDetail } from './api';
import { breadcrumbJsonLd, productJsonLd, serializeJsonLd, webSiteJsonLd } from './jsonld';

function makeProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'id-1',
    slug: 'filtre-16x25x1',
    slugs: { fr: 'filtre-16x25x1', en: 'filter-16x25x1' },
    name: 'Filtre MERV 11 — 16x25x1',
    shortDescription: 'Filtre plissé.',
    description: null,
    metaTitle: null,
    metaDescription: null,
    brand: { slug: 'boreal-filtration', name: 'Boréal Filtration' },
    category: null,
    equipmentKinds: [],
    variants: [
      {
        id: 'v1',
        sku: 'BF-16-25-1-M11',
        nominalLabel: '16x25x1',
        nominalWidthIn: 16,
        nominalHeightIn: 25,
        nominalDepthIn: 1,
        actualWidthIn: 15.75,
        actualHeightIn: 24.75,
        actualDepthIn: 0.75,
        merv: 11,
        packSize: 1,
        priceCents: 1399,
        compareAtPriceCents: null,
        currency: 'CAD',
        availableQuantity: 10,
        inStock: true,
      },
      {
        id: 'v2',
        sku: 'BF-16-25-1-M11-B6',
        nominalLabel: '16x25x1',
        nominalWidthIn: 16,
        nominalHeightIn: 25,
        nominalDepthIn: 1,
        actualWidthIn: 15.75,
        actualHeightIn: 24.75,
        actualDepthIn: 0.75,
        merv: 11,
        packSize: 6,
        priceCents: 7199,
        compareAtPriceCents: null,
        currency: 'CAD',
        availableQuantity: 0,
        inStock: false,
      },
    ],
    images: [],
    reviews: { average: 0, count: 0 },
    related: [],
    ...overrides,
  };
}

describe('productJsonLd', () => {
  it('offres agrégées : bornes de prix, devise, disponibilité', () => {
    const data = productJsonLd({
      product: makeProduct(),
      url: 'https://filtrationmontreal.com/produits/filtre-16x25x1',
      locale: 'fr',
    });

    expect(data['@type']).toBe('Product');
    expect(data.brand).toEqual({ '@type': 'Brand', name: 'Boréal Filtration' });
    expect(data.offers).toMatchObject({
      '@type': 'AggregateOffer',
      priceCurrency: 'CAD',
      lowPrice: '13.99',
      highPrice: '71.99',
      offerCount: 2,
      availability: 'https://schema.org/InStock',
    });
  });

  it('aggregateRating ABSENT sans avis, présent avec avis', () => {
    const without = productJsonLd({ product: makeProduct(), url: 'u', locale: 'fr' });
    expect(without).not.toHaveProperty('aggregateRating');

    const withReviews = productJsonLd({
      product: makeProduct({ reviews: { average: 4.7, count: 12 } }),
      url: 'u',
      locale: 'fr',
    });
    expect(withReviews.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.7,
      reviewCount: 12,
    });
  });

  it('OutOfStock quand aucune variante en stock; image omise si vide', () => {
    const product = makeProduct();
    product.variants = product.variants.map((v) => ({ ...v, inStock: false }));
    const data = productJsonLd({ product, url: 'u', locale: 'fr' });
    expect((data.offers as Record<string, unknown>).availability).toBe(
      'https://schema.org/OutOfStock',
    );
    expect(data).not.toHaveProperty('image');
  });
});

describe('breadcrumbJsonLd', () => {
  it('numérote les positions; dernier élément sans URL', () => {
    const data = breadcrumbJsonLd([
      { name: 'Accueil', url: 'https://filtrationmontreal.com/' },
      { name: 'Tailles', url: 'https://filtrationmontreal.com/tailles' },
      { name: '16x25x1' },
    ]);
    const items = data.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ position: 1, item: 'https://filtrationmontreal.com/' });
    expect(items[2]).toEqual({ '@type': 'ListItem', position: 3, name: '16x25x1' });
  });
});

describe('webSiteJsonLd', () => {
  it('expose une SearchAction vers la page de recherche localisée', () => {
    const data = webSiteJsonLd('fr');
    const action = data.potentialAction as { target: { urlTemplate: string } };
    expect(action.target.urlTemplate).toContain('q={search_term_string}');
  });
});

describe('serializeJsonLd', () => {
  it('échappe < pour empêcher la fermeture du script', () => {
    const out = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script');
  });
});
