/**
 * Crawl de vérification des vitrines BigCommerce — tâche 25.
 *
 * Deux sources d'inventaire, dans cet ordre de confiance :
 *  1. les sitemaps XML publics (robots.txt → lignes `Sitemap:` → sitemapindex
 *     → urlset) : l'inventaire officiel du contenu servi (pages, produits,
 *     catégories, marques, billets de blogue) — indispensable pour le FR dont
 *     le jeton API n'est pas encore fourni ;
 *  2. un parcours BFS borné depuis la page d'accueil, qui attrape ce que les
 *     sitemaps omettent (pagination du blogue, liens internes divers).
 *
 * Lecture seule et poli : User-Agent identifiant, délai entre chaque requête,
 * budget global de requêtes, timeout par requête, règles `Disallow` de
 * robots.txt respectées — les chemins interdits ne sont ni visités ni
 * enregistrés (les URL système comme `/cart.php` sont couvertes par les
 * décisions versionnées du générateur, pas par le crawl).
 *
 * `fetchImpl` est injectable pour les tests : aucun réseau, aucun délai.
 */
import { XMLParser } from 'fast-xml-parser';
import { type FetchLike } from './client';

export type CrawlDiscovery =
  | 'sitemap:pages'
  | 'sitemap:products'
  | 'sitemap:categories'
  | 'sitemap:brands'
  | 'sitemap:news'
  | 'sitemap:other'
  | 'crawl';

export interface CrawledUrl {
  /** Chemin tel que découvert (casse préservée, sans requête ni fragment). */
  path: string;
  discovery: CrawlDiscovery;
  /** Statut HTTP observé si le chemin a été visité par le BFS (redirections
   *  non suivies : un 301 est enregistré tel quel). */
  status?: number;
}

export interface CrawlStorefrontOptions {
  /** Origine canonique de la vitrine, ex. `https://www.exemple.com`. */
  origin: string;
  fetchImpl?: FetchLike;
  /** Délai de politesse entre deux requêtes, en ms. */
  delayMs?: number;
  /** Budget global de requêtes HTTP (sitemaps compris). */
  maxFetches?: number;
  /** Profondeur maximale du BFS depuis la page d'accueil. */
  maxDepth?: number;
  /** Timeout d'une requête, en ms. */
  timeoutMs?: number;
  userAgent?: string;
  log?: (message: string) => void;
}

export interface RobotsRules {
  sitemaps: string[];
  disallows: string[];
}

const DEFAULT_USER_AGENT =
  'ffc-crawler-verification/1.0 (verification pre-migration; lecture seule)';

/** Extensions d'assets jamais considérées comme du contenu à rediriger. */
const ASSET_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|json|xml|txt|pdf|zip|gz|woff2?|ttf|eot|otf|mp4|webm|mp3|rss)$/i;

const HREF_RE = /href\s*=\s*["']([^"'#]+)/gi;

/** Taille maximale de HTML analysée par page (le reste est ignoré). */
const MAX_HTML_BYTES = 1_500_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Lecture minimaliste de robots.txt : lignes `Sitemap:` (tous groupes) et
 * règles `Disallow:` des groupes visant `User-agent: *` (préfixes simples,
 * suffisant pour les robots.txt BigCommerce).
 */
export function parseRobotsTxt(body: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallows: string[] = [];
  let agents: string[] = [];
  let inRuleBlock = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (inRuleBlock) {
        agents = [];
        inRuleBlock = false;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if (key === 'disallow' || key === 'allow') {
      inRuleBlock = true;
      if (key === 'disallow' && value && agents.includes('*')) {
        disallows.push(value.replace(/\*+$/, ''));
      }
    }
  }

  return { sitemaps, disallows };
}

/** `true` si le chemin tombe sous une règle `Disallow` (préfixe simple). */
export function isDisallowed(path: string, disallows: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return disallows.some((rule) => rule.length > 0 && lower.startsWith(rule.toLowerCase()));
}

function sitemapDiscovery(sitemapUrl: string): CrawlDiscovery {
  const match = /(pages|products|categories|brands|news)/i.exec(sitemapUrl);
  switch (match?.[1]?.toLowerCase()) {
    case 'pages':
      return 'sitemap:pages';
    case 'products':
      return 'sitemap:products';
    case 'categories':
      return 'sitemap:categories';
    case 'brands':
      return 'sitemap:brands';
    case 'news':
      return 'sitemap:news';
    default:
      return 'sitemap:other';
  }
}

/** Même site : hôtes identiques au préfixe `www.` près (apex ↔ www). */
function isSameSite(url: URL, canonical: URL): boolean {
  return (
    url.hostname.replace(/^www\./, '').toLowerCase() ===
    canonical.hostname.replace(/^www\./, '').toLowerCase()
  );
}

interface SitemapDocument {
  sitemapindex?: { sitemap?: { loc?: string } | Array<{ loc?: string }> };
  urlset?: { url?: { loc?: string } | Array<{ loc?: string }> };
}

/**
 * Inventorie les URL d'une vitrine : sitemaps d'abord, puis BFS borné.
 * Retourne les chemins dédupliqués (la découverte sitemap prime sur le BFS),
 * triés par chemin pour un résultat reproductible.
 */
export async function crawlStorefront(options: CrawlStorefrontOptions): Promise<CrawledUrl[]> {
  const canonical = new URL(options.origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayMs = options.delayMs ?? 300;
  const maxFetches = options.maxFetches ?? 300;
  const maxDepth = options.maxDepth ?? 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const log = options.log ?? (() => undefined);
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

  const entries = new Map<string, CrawledUrl>();
  let fetchesUsed = 0;

  const politeFetch = async (url: string): Promise<Response | null> => {
    if (fetchesUsed >= maxFetches) return null;
    if (fetchesUsed > 0 && delayMs > 0) await sleep(delayMs);
    fetchesUsed += 1;
    try {
      return await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xml,text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      log(`  [avertissement] échec de requête sur ${url} : ${String(error)}`);
      return null;
    }
  };

  const record = (path: string, discovery: CrawlDiscovery): CrawledUrl => {
    const key = path.toLowerCase();
    const existing = entries.get(key);
    if (existing) {
      if (existing.discovery === 'crawl' && discovery !== 'crawl') {
        existing.discovery = discovery;
      }
      return existing;
    }
    const entry: CrawledUrl = { path, discovery };
    entries.set(key, entry);
    return entry;
  };

  // 1. robots.txt : sitemaps annoncés + règles Disallow à respecter.
  let robots: RobotsRules = { sitemaps: [], disallows: [] };
  const robotsResponse = await politeFetch(`${canonical.origin}/robots.txt`);
  if (robotsResponse?.ok) {
    robots = parseRobotsTxt(await robotsResponse.text());
    log(
      `robots.txt : ${robots.sitemaps.length} sitemap(s), ${robots.disallows.length} règle(s) Disallow`,
    );
  } else {
    log(`robots.txt indisponible (statut ${robotsResponse?.status ?? 'aucun'}) — repli`);
  }

  // 2. Sitemaps : index → urlsets, chaque <loc> même site devient une entrée.
  const sitemapQueue = (
    robots.sitemaps.length > 0 ? robots.sitemaps : [`${canonical.origin}/xmlsitemap.php`]
  ).map((url) => ({ url, discovery: sitemapDiscovery(url) }));
  const seenSitemaps = new Set<string>();

  while (sitemapQueue.length > 0) {
    const { url, discovery } = sitemapQueue.shift()!;
    if (seenSitemaps.has(url)) continue;
    seenSitemaps.add(url);

    let sitemapUrl: URL;
    try {
      sitemapUrl = new URL(url);
    } catch {
      continue;
    }
    if (!isSameSite(sitemapUrl, canonical)) continue;

    const response = await politeFetch(url);
    if (!response?.ok) {
      log(`  [avertissement] sitemap ${url} : statut ${response?.status ?? 'aucun'}`);
      continue;
    }

    const document = parser.parse(await response.text()) as SitemapDocument;
    for (const child of asArray(document.sitemapindex?.sitemap)) {
      if (child.loc) sitemapQueue.push({ url: child.loc, discovery: sitemapDiscovery(child.loc) });
    }

    let recorded = 0;
    for (const urlEntry of asArray(document.urlset?.url)) {
      if (!urlEntry.loc) continue;
      let loc: URL;
      try {
        loc = new URL(urlEntry.loc);
      } catch {
        continue;
      }
      if (!isSameSite(loc, canonical)) continue;
      if (ASSET_EXTENSION_RE.test(loc.pathname)) continue;
      if (isDisallowed(loc.pathname, robots.disallows)) continue;
      record(loc.pathname, discovery);
      recorded += 1;
    }
    if (recorded > 0) log(`  sitemap ${discovery} : ${recorded} URL`);
  }

  // 3. BFS borné depuis l'accueil : liens internes, pagination du blogue…
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: '/', depth: 0 }];

  while (queue.length > 0 && fetchesUsed < maxFetches) {
    const { path, depth } = queue.shift()!;
    const key = path.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (isDisallowed(path, robots.disallows)) continue;

    const response = await politeFetch(`${canonical.origin}${path}`);
    if (!response) continue;

    const entry = record(path, 'crawl');
    entry.status = response.status;

    if (response.status !== 200 || depth >= maxDepth) continue;
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) continue;

    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    for (const match of html.matchAll(HREF_RE)) {
      const href = (match[1] ?? '').trim();
      if (!href || /^(?:mailto:|tel:|javascript:|data:)/i.test(href)) continue;
      let target: URL;
      try {
        target = new URL(href, `${canonical.origin}${path}`);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(target.protocol)) continue;
      if (!isSameSite(target, canonical)) continue;
      if (target.pathname.length > 400) continue;
      if (ASSET_EXTENSION_RE.test(target.pathname)) continue;
      if (isDisallowed(target.pathname, robots.disallows)) continue;
      if (!visited.has(target.pathname.toLowerCase())) {
        queue.push({ path: target.pathname, depth: depth + 1 });
      }
    }
  }

  if (queue.length > 0 && fetchesUsed >= maxFetches) {
    log(`Budget de ${maxFetches} requêtes épuisé — ${queue.length} chemin(s) non visités`);
  }
  log(`Crawl terminé : ${entries.size} chemin(s), ${fetchesUsed} requête(s)`);

  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
