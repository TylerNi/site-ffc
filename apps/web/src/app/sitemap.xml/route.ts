import { type Locale } from '@ffc/i18n';
import { getSitemapData } from '@/lib/api';
import { localeForHost } from '@/lib/site';
import { buildSitemapXml, sitemapEntries } from '@/lib/sitemap';

/**
 * Sitemap par domaine : filtrationmontreal.com liste les URL françaises,
 * furnacefilterscanada.com les anglaises — chacune avec ses alternates
 * hreflang inter-domaines. En dev (origine partagée), les deux locales.
 * Hôte inconnu (staging) : 404 — robots.txt y bloque déjà tout.
 */
export async function GET(request: Request): Promise<Response> {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const mode = localeForHost(host);
  if (mode === null) {
    return new Response('Not found', { status: 404 });
  }

  const data = await getSitemapData();
  if (!data || data === 'not-found') {
    // API indisponible : demander aux robots de repasser, ne jamais servir
    // un sitemap vide (désindexation accidentelle).
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'Retry-After': '300' },
    });
  }

  const forLocales: Locale[] = mode === 'shared' ? ['en', 'fr'] : [mode];
  const xml = buildSitemapXml(sitemapEntries(forLocales, data));

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
