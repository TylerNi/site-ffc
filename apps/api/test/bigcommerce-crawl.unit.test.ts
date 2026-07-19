import { describe, expect, it, vi } from 'vitest';
import {
  crawlStorefront,
  isDisallowed,
  parseRobotsTxt,
  type CrawledUrl,
} from '../src/bigcommerce/crawl';

const ORIGIN = 'https://www.shop-test.com';

function response(body: string, init?: { status?: number; contentType?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': init?.contentType ?? 'text/html; charset=utf-8' },
  });
}

const ROBOTS = [
  'User-agent: *',
  'Disallow: /cart.php',
  'Disallow: /search.php',
  '',
  `Sitemap: ${ORIGIN}/xmlsitemap.php`,
].join('\n');

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${ORIGIN}/xmlsitemap.php?type=products&amp;page=1</loc></sitemap>
  <sitemap><loc>${ORIGIN}/xmlsitemap.php?type=pages&amp;page=1</loc></sitemap>
</sitemapindex>`;

const SITEMAP_PRODUCTS = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/m8-1056/</loc></url>
  <url><loc>${ORIGIN}/cart.php</loc></url>
  <url><loc>${ORIGIN}/image.jpg</loc></url>
  <url><loc>https://ailleurs.example.com/hors-site/</loc></url>
</urlset>`;

// Une SEULE <url> : fast-xml-parser produit un objet, pas un tableau.
const SITEMAP_PAGES = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/about-us/</loc></url>
</urlset>`;

const HOME_HTML = `<html><body>
  <a href="/blog/">Blog</a>
  <a href="/m8-1056/">Produit</a>
  <a href="/cart.php">Panier</a>
  <a href="/old">Ancien</a>
  <a href="/styles.css">css</a>
  <a href="mailto:x@y.com">courriel</a>
  <a href="https://ailleurs.example.com/promo">ailleurs</a>
</body></html>`;

const BLOG_HTML = '<html><body><a href="/blog/page-2/">Suivant</a></body></html>';

function fakeSite(overrides: Record<string, Response | (() => Response)> = {}) {
  const routes: Record<string, () => Response> = {
    [`${ORIGIN}/robots.txt`]: () => response(ROBOTS, { contentType: 'text/plain' }),
    [`${ORIGIN}/xmlsitemap.php`]: () => response(SITEMAP_INDEX, { contentType: 'application/xml' }),
    [`${ORIGIN}/xmlsitemap.php?type=products&page=1`]: () =>
      response(SITEMAP_PRODUCTS, { contentType: 'application/xml' }),
    [`${ORIGIN}/xmlsitemap.php?type=pages&page=1`]: () =>
      response(SITEMAP_PAGES, { contentType: 'application/xml' }),
    [`${ORIGIN}/`]: () => response(HOME_HTML),
    [`${ORIGIN}/blog/`]: () => response(BLOG_HTML),
    [`${ORIGIN}/blog/page-2/`]: () => response('<html><body>fin</body></html>'),
    [`${ORIGIN}/m8-1056/`]: () => response('<html><body>produit</body></html>'),
    [`${ORIGIN}/old`]: () => response('', { status: 301 }),
    [`${ORIGIN}/about-us/`]: () => response('<html><body>page</body></html>'),
  };
  for (const [url, value] of Object.entries(overrides)) {
    routes[url] = typeof value === 'function' ? value : () => value;
  }
  return vi.fn(async (url: string) => routes[url]?.() ?? response('absent', { status: 404 }));
}

function byPath(urls: CrawledUrl[]): Map<string, CrawledUrl> {
  return new Map(urls.map((entry) => [entry.path, entry]));
}

/**
 * Crawl de vérification (tâche 25 §2) : sitemaps + BFS borné, robots.txt
 * respecté, fetch injecté — aucun réseau ni délai réel dans les tests.
 */
describe('bigcommerce/crawl — robots.txt', () => {
  it('extrait sitemaps et règles Disallow du groupe *', () => {
    const rules = parseRobotsTxt(ROBOTS);
    expect(rules.sitemaps).toEqual([`${ORIGIN}/xmlsitemap.php`]);
    expect(rules.disallows).toEqual(['/cart.php', '/search.php']);
    expect(isDisallowed('/cart.php', rules.disallows)).toBe(true);
    expect(isDisallowed('/CART.php?x=1', rules.disallows)).toBe(true);
    expect(isDisallowed('/carte', rules.disallows)).toBe(false);
  });

  it("ignore les groupes d'autres agents et gère préfixes à étoile", () => {
    const rules = parseRobotsTxt(
      [
        'User-agent: badbot',
        'Disallow: /',
        '',
        'User-agent: *',
        'Disallow: /admin*',
        'Allow: /admin/public',
        'Disallow:',
      ].join('\n'),
    );
    expect(rules.disallows).toEqual(['/admin']);
  });
});

describe('bigcommerce/crawl — sitemaps + BFS', () => {
  it('inventorie sitemaps (index → urlsets) puis liens internes, dédupliqués et triés', async () => {
    const fetchImpl = fakeSite();
    const urls = await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0 });
    const entries = byPath(urls);

    expect(entries.get('/m8-1056/')).toMatchObject({ discovery: 'sitemap:products', status: 200 });
    expect(entries.get('/about-us/')).toMatchObject({ discovery: 'sitemap:pages' });
    expect(entries.get('/blog/')).toMatchObject({ discovery: 'crawl', status: 200 });
    expect(entries.get('/blog/page-2/')).toMatchObject({ discovery: 'crawl', status: 200 });
    expect(entries.get('/old')).toMatchObject({ discovery: 'crawl', status: 301 });

    expect(entries.has('/cart.php')).toBe(false);
    expect(entries.has('/search.php')).toBe(false);
    expect(entries.has('/image.jpg')).toBe(false);
    expect(entries.has('/styles.css')).toBe(false);
    expect(entries.has('/hors-site/')).toBe(false);
    expect(entries.has('/promo')).toBe(false);

    const paths = urls.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('ne suit pas les liens des réponses non-200 et note leur statut', async () => {
    const fetchImpl = fakeSite({
      [`${ORIGIN}/old`]: response('<a href="/piege/">piège</a>', { status: 301 }),
    });
    const urls = await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0 });
    expect(byPath(urls).has('/piege/')).toBe(false);
  });

  it('respecte le budget global de requêtes', async () => {
    const fetchImpl = fakeSite();
    await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0, maxFetches: 4 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('respecte la profondeur maximale du BFS', async () => {
    const fetchImpl = fakeSite();
    const urls = await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0, maxDepth: 1 });
    const entries = byPath(urls);
    expect(entries.get('/blog/')?.status).toBe(200);
    expect(entries.has('/blog/page-2/')).toBe(false);
  });

  it('robots.txt indisponible : repli sur /xmlsitemap.php, aucun Disallow', async () => {
    const fetchImpl = fakeSite({
      [`${ORIGIN}/robots.txt`]: response('absent', { status: 404 }),
    });
    const urls = await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0 });
    const entries = byPath(urls);
    expect(entries.get('/m8-1056/')?.discovery).toBe('sitemap:products');
    // Sans robots.txt, /cart.php (listé au sitemap produits) n'est plus filtré.
    expect(entries.has('/cart.php')).toBe(true);
  });

  it("un échec réseau sur un chemin n'arrête pas le crawl", async () => {
    const fetchImpl = fakeSite({
      [`${ORIGIN}/blog/`]: () => {
        throw new Error('réseau coupé');
      },
    });
    const urls = await crawlStorefront({ origin: ORIGIN, fetchImpl, delayMs: 0 });
    const entries = byPath(urls);
    expect(entries.get('/m8-1056/')?.status).toBe(200);
    expect(entries.has('/blog/page-2/')).toBe(false);
  });
});
