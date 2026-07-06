import { localeForHost, localizedPath, siteOrigin } from '@/lib/site';
import { robotsBody } from '@/lib/sitemap';

/**
 * robots.txt par domaine : sitemap du domaine + pages de recherche exclues
 * du crawl. Hôte inconnu (staging, IP directe) : tout est bloqué — le
 * contenu ne doit s'indexer que sur les domaines officiels.
 */
export function GET(request: Request): Response {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const mode = localeForHost(host);

  let body: string;
  if (mode === null) {
    body = robotsBody({ origin: null, searchPaths: [] });
  } else if (mode === 'shared') {
    body = robotsBody({
      origin: siteOrigin('en'),
      searchPaths: [localizedPath('en', '/search'), localizedPath('fr', '/search')],
    });
  } else {
    body = robotsBody({
      origin: siteOrigin(mode),
      searchPaths: [localizedPath(mode, '/search')],
    });
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
