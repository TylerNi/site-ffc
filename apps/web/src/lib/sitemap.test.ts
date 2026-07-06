import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SitemapData } from './api';
import { buildSitemapXml, robotsBody, sitemapEntries } from './sitemap';

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

const data: SitemapData = {
  products: [
    {
      id: 'p1',
      slugs: { fr: 'filtre-16x25x1', en: 'filter-16x25x1' },
      updatedAt: '2026-07-01T12:00:00.000Z',
    },
    // Produit sans traduction anglaise : absent du sitemap en.
    {
      id: 'p2',
      slugs: { fr: 'filtre-francais-seulement', en: null },
      updatedAt: '2026-07-02T12:00:00.000Z',
    },
  ],
  categories: [{ slugs: { fr: 'filtres-de-fournaise', en: 'furnace-filters' } }],
  sizes: ['16x25x1'],
};

describe('sitemapEntries', () => {
  it('domaine fr : URL fr seulement, alternates vers les deux domaines', () => {
    const entries = sitemapEntries(['fr'], data);
    const urls = entries.map((e) => e.url);

    expect(urls).toContain('https://filtrationmontreal.com/');
    expect(urls).toContain('https://filtrationmontreal.com/tailles');
    expect(urls).toContain('https://filtrationmontreal.com/tailles/16x25x1');
    expect(urls).toContain('https://filtrationmontreal.com/categories/filtres-de-fournaise');
    expect(urls).toContain('https://filtrationmontreal.com/produits/filtre-16x25x1');
    // Jamais d'URL du domaine anglais dans le sitemap français.
    expect(urls.every((url) => url.startsWith('https://filtrationmontreal.com/'))).toBe(true);

    const product = entries.find((e) => e.url.endsWith('/produits/filtre-16x25x1'));
    expect(product?.lastmod).toBe('2026-07-01T12:00:00.000Z');
    expect(product?.alternates).toEqual([
      {
        hreflang: 'fr-CA',
        href: 'https://filtrationmontreal.com/produits/filtre-16x25x1',
      },
      {
        hreflang: 'en-CA',
        href: 'https://furnacefilterscanada.com/products/filter-16x25x1',
      },
      {
        hreflang: 'x-default',
        href: 'https://furnacefilterscanada.com/products/filter-16x25x1',
      },
    ]);
  });

  it('produit sans traduction en : exclu du sitemap en, sans alternate en', () => {
    const en = sitemapEntries(['en'], data);
    expect(en.some((e) => e.url.includes('francais-seulement'))).toBe(false);

    const fr = sitemapEntries(['fr'], data);
    const frOnly = fr.find((e) => e.url.includes('francais-seulement'));
    expect(frOnly).toBeDefined();
    expect(frOnly!.alternates.some((a) => a.hreflang === 'en-CA')).toBe(false);
    expect(frOnly!.alternates.some((a) => a.hreflang === 'x-default')).toBe(false);
  });

  it('mode partagé (dev) : les deux locales, préfixe /fr', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL_FR;
    delete process.env.NEXT_PUBLIC_SITE_URL_EN;
    const entries = sitemapEntries(['en', 'fr'], data);
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('http://localhost:3000/');
    expect(urls).toContain('http://localhost:3000/fr/tailles/16x25x1');
    expect(urls).toContain('http://localhost:3000/sizes/16x25x1');
  });
});

describe('buildSitemapXml', () => {
  it('XML valide : loc, lastmod, xhtml:link, échappement', () => {
    const xml = buildSitemapXml([
      {
        url: 'https://filtrationmontreal.com/recherche?q=a&b=c',
        lastmod: '2026-07-01T12:00:00.000Z',
        alternates: [{ hreflang: 'fr-CA', href: 'https://filtrationmontreal.com/x' }],
      },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('<loc>https://filtrationmontreal.com/recherche?q=a&amp;b=c</loc>');
    expect(xml).toContain('<lastmod>2026-07-01T12:00:00.000Z</lastmod>');
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="fr-CA" href="https://filtrationmontreal.com/x"/>',
    );
    // Aucune esperluette nue.
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
  });
});

describe('robotsBody', () => {
  it('hôte connu : sitemap référencé, recherche bloquée', () => {
    const body = robotsBody({
      origin: 'https://filtrationmontreal.com',
      searchPaths: ['/recherche'],
    });
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /recherche');
    expect(body).toContain('Sitemap: https://filtrationmontreal.com/sitemap.xml');
    expect(body).not.toMatch(/Disallow: \/$/m);
  });

  it('hôte inconnu : tout est bloqué', () => {
    const body = robotsBody({ origin: null, searchPaths: [] });
    expect(body).toContain('Disallow: /');
    expect(body).not.toContain('Sitemap:');
  });
});
