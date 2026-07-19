/**
 * Inventaire des URL publiques des deux vitrines BigCommerce — tâche 25 §2.
 *
 * Usage (aucun jeton requis, sitemaps et pages publics uniquement) :
 *   pnpm --filter @ffc/api bigcommerce:crawl [--max-fetches=300] [--delay-ms=300]
 *
 * Écrit data/urls-crawl.csv (colonnes : domaine,type,url,source,statut) —
 * commité, consommé par `bigcommerce:redirects` comme seconde source après le
 * CSV de la tâche 08. Lecture seule, poli (User-Agent identifiant, délai
 * entre requêtes, budget borné, robots.txt respecté).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crawlStorefront, type CrawlDiscovery, type CrawledUrl } from '../../src/bigcommerce/crawl';

const DISCOVERY_TO_TYPE: Record<CrawlDiscovery, string> = {
  'sitemap:products': 'product',
  'sitemap:categories': 'category',
  'sitemap:pages': 'page',
  'sitemap:brands': 'brand',
  'sitemap:news': 'blog',
  'sitemap:other': 'other',
  crawl: 'other',
};

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function argNumber(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.split('=')[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Valeur invalide pour --${name} : ${raw}`);
  }
  return value;
}

/** Hôte canonique servi (les deux vitrines redirigent l'apex vers www). */
function canonicalHost(domain: string): string {
  return `www.${domain.replace(/^www\./, '')}`;
}

async function main(): Promise<void> {
  const maxFetches = argNumber('max-fetches', 300);
  const delayMs = argNumber('delay-ms', 300);
  const hosts = [
    canonicalHost(process.env.BIGCOMMERCE_DOMAIN_EN ?? 'furnacefilterscanada.com'),
    canonicalHost(process.env.BIGCOMMERCE_DOMAIN_FR ?? 'filtrationmontreal.com'),
  ];

  const lines = ['domaine,type,url,source,statut'];
  for (const host of hosts) {
    console.log(`Crawl de https://${host} (budget ${maxFetches} requêtes, délai ${delayMs} ms)`);
    const urls: CrawledUrl[] = await crawlStorefront({
      origin: `https://${host}`,
      maxFetches,
      delayMs,
      log: (message) => console.log(`  ${message}`),
    });
    for (const entry of urls) {
      lines.push(
        [
          host,
          DISCOVERY_TO_TYPE[entry.discovery],
          entry.path,
          entry.discovery,
          entry.status === undefined ? '' : String(entry.status),
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    console.log(`  → ${urls.length} chemin(s) pour ${host}`);
  }

  const outPath = join(__dirname, '..', '..', '..', '..', 'data', 'urls-crawl.csv');
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Écrit : ${outPath} (${lines.length - 1} lignes)`);
}

void main();
