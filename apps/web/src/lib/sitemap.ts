import { type Locale, locales } from '@ffc/i18n';
import { type SitemapData } from './api';
import { absoluteUrl, type LocalizedHref } from './site';

/**
 * Construction des sitemaps XML par domaine. Chaque URL porte ses alternates
 * hreflang inter-domaines (`xhtml:link`) — le protocole recommandé par Google
 * pour les sites multilingues multi-domaines. Fonctions PURES, testées.
 */

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  alternates: Array<{ hreflang: string; href: string }>;
}

const HREFLANG: Record<Locale, string> = { fr: 'fr-CA', en: 'en-CA' };

/** Alternates fr/en/x-default d'un href par locale (locale absente = omise). */
function alternatesFor(hrefs: Partial<Record<Locale, LocalizedHref>>): SitemapEntry['alternates'] {
  const alternates: SitemapEntry['alternates'] = [];
  for (const locale of locales) {
    const href = hrefs[locale];
    if (href) alternates.push({ hreflang: HREFLANG[locale], href: absoluteUrl(locale, href) });
  }
  if (hrefs.en) alternates.push({ hreflang: 'x-default', href: absoluteUrl('en', hrefs.en) });
  return alternates;
}

/**
 * Entrées du sitemap pour les locales demandées (une seule en production —
 * le domaine porte la locale; les deux en dev où l'origine est partagée).
 */
export function sitemapEntries(forLocales: Locale[], data: SitemapData): SitemapEntry[] {
  const entries: SitemapEntry[] = [];

  const push = (hrefs: Partial<Record<Locale, LocalizedHref>>, lastmod?: string): void => {
    const alternates = alternatesFor(hrefs);
    for (const locale of forLocales) {
      const href = hrefs[locale];
      if (!href) continue;
      entries.push({ url: absoluteUrl(locale, href), lastmod, alternates });
    }
  };

  push({ fr: '/', en: '/' });
  push({ fr: '/sizes', en: '/sizes' });

  for (const size of data.sizes) {
    const href = { pathname: '/sizes/[label]', params: { label: size } } as const;
    push({ fr: href, en: href });
  }

  for (const category of data.categories) {
    push({
      fr: category.slugs.fr
        ? { pathname: '/categories/[slug]', params: { slug: category.slugs.fr } }
        : undefined,
      en: category.slugs.en
        ? { pathname: '/categories/[slug]', params: { slug: category.slugs.en } }
        : undefined,
    });
  }

  for (const product of data.products) {
    push(
      {
        fr: product.slugs.fr
          ? { pathname: '/products/[slug]', params: { slug: product.slugs.fr } }
          : undefined,
        en: product.slugs.en
          ? { pathname: '/products/[slug]', params: { slug: product.slugs.en } }
          : undefined,
      },
      product.updatedAt,
    );
  }

  return entries;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Sérialise les entrées en XML sitemap (namespace xhtml pour les alternates). */
export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const alternates = entry.alternates
        .map(
          (a) =>
            `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeXml(a.href)}"/>`,
        )
        .join('\n');
      const lastmod = entry.lastmod ? `    <lastmod>${escapeXml(entry.lastmod)}</lastmod>\n` : '';
      return `  <url>\n    <loc>${escapeXml(entry.url)}</loc>\n${lastmod}${alternates}\n  </url>`;
    })
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    `${urls}\n` +
    '</urlset>\n'
  );
}

/**
 * Corps de robots.txt selon l'hôte : les domaines connus référencent leur
 * sitemap et bloquent les pages de recherche (crawl budget); tout autre hôte
 * (staging, IP directe) est intégralement bloqué.
 */
export function robotsBody(params: { origin: string | null; searchPaths: string[] }): string {
  if (!params.origin) {
    return 'User-agent: *\nDisallow: /\n';
  }
  const disallows = params.searchPaths.map((path) => `Disallow: ${path}`).join('\n');
  return `User-agent: *\n${disallows}\n\nSitemap: ${params.origin}/sitemap.xml\n`;
}
