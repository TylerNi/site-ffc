import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pageMetadata } from './seo';

const ENV_KEYS = ['NEXT_PUBLIC_SITE_URL_FR', 'NEXT_PUBLIC_SITE_URL_EN'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_SITE_URL_FR = 'https://filtrationmontreal.com';
  process.env.NEXT_PUBLIC_SITE_URL_EN = 'https://furnacefilterscanada.com';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('pageMetadata', () => {
  it('canonical + hreflang inter-domaines avec slugs localisés', () => {
    const metadata = pageMetadata({
      locale: 'fr',
      hrefs: {
        fr: { pathname: '/products/[slug]', params: { slug: 'filtre-16x25x1' } },
        en: { pathname: '/products/[slug]', params: { slug: 'filter-16x25x1' } },
      },
      title: 'Filtre 16x25x1',
      description: 'Description',
    });

    expect(metadata.alternates?.canonical).toBe(
      'https://filtrationmontreal.com/produits/filtre-16x25x1',
    );
    expect(metadata.alternates?.languages).toEqual({
      'fr-CA': 'https://filtrationmontreal.com/produits/filtre-16x25x1',
      'en-CA': 'https://furnacefilterscanada.com/products/filter-16x25x1',
      'x-default': 'https://furnacefilterscanada.com/products/filter-16x25x1',
    });
    expect(metadata.robots).toBeUndefined();
  });

  it('omet l’alternate d’une locale sans traduction', () => {
    const metadata = pageMetadata({
      locale: 'en',
      hrefs: { en: { pathname: '/products/[slug]', params: { slug: 'only-english' } } },
      title: 'English only',
    });

    const languages = metadata.alternates?.languages as Record<string, string>;
    expect(languages['fr-CA']).toBeUndefined();
    expect(languages['en-CA']).toContain('furnacefilterscanada.com');
    expect(languages['x-default']).toContain('furnacefilterscanada.com');
  });

  it('noindex → robots index:false, follow:true', () => {
    const metadata = pageMetadata({
      locale: 'fr',
      hrefs: { fr: '/search', en: '/search' },
      title: 'Recherche',
      noindex: true,
    });
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('href avec query (page de recherche)', () => {
    const metadata = pageMetadata({
      locale: 'fr',
      hrefs: {
        fr: { pathname: '/search', query: { q: '16x25x1' } },
        en: { pathname: '/search', query: { q: '16x25x1' } },
      },
      title: 'Recherche',
      noindex: true,
    });
    expect(metadata.alternates?.canonical).toBe(
      'https://filtrationmontreal.com/recherche?q=16x25x1',
    );
  });
});
