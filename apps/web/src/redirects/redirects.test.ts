import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeRedirectPath,
  REDIRECTS_ENV_FLAG,
  type Locale,
  type RedirectEntry,
} from '@ffc/core';
import { routing } from '../i18n/routing';
import { localizedPath, type LocalizedHref } from '../lib/site';
import { goneResponseBody, redirectsArtifact, resolveRedirect } from './index';

/**
 * Validation de l'ARTEFACT RÉEL commité (tâche 25 §5) : 100 % des entrées
 * sont exercées contre le résolveur du middleware, les cibles sont recroisées
 * avec le routage réel (`routing.ts`), et chaque URL des inventaires (CSV
 * tâche 08 + crawl) est comptabilisée dans exactement un état — exacte, 410,
 * écart documenté ou ignorée à bon droit.
 */

const repoRoot = join(process.cwd(), '..', '..');

const EN_HOST = 'www.furnacefilterscanada.com';
const FR_HOST = 'www.filtrationmontreal.com';

interface EcartsFile {
  gaps: Array<{ host: string; path: string; reason: string }>;
  ignored: Array<{ host: string; path: string; reason: string }>;
}
const ecarts = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'redirections-ecarts.json'), 'utf8'),
) as EcartsFile;

/** CSV simples du dépôt : aucun champ quoté attendu (garde-fou vérifié). */
function readCsvRows(file: string): string[][] {
  const lines = readFileSync(join(repoRoot, 'data', file), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(1);
  for (const line of lines) expect(line, `${file} : champ quoté inattendu`).not.toContain('"');
  return lines.map((line) => line.split(','));
}

const ENV_KEYS = ['NEXT_PUBLIC_SITE_URL_FR', 'NEXT_PUBLIC_SITE_URL_EN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
  // Mode production (un domaine par locale) : les cibles de l'artefact sont
  // des chemins SANS préfixe de locale — comme à la bascule.
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_SITE_URL_FR = `https://${FR_HOST}`;
  process.env.NEXT_PUBLIC_SITE_URL_EN = `https://${EN_HOST}`;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('structure de l’artefact', () => {
  it('deux hôtes canoniques www, apex en alias, origines https', () => {
    expect(redirectsArtifact.version).toBe(1);
    expect(Object.keys(redirectsArtifact.hosts).sort()).toEqual([FR_HOST, EN_HOST].sort());
    expect(redirectsArtifact.hosts[EN_HOST]).toMatchObject({
      locale: 'en',
      origin: `https://${EN_HOST}`,
      aliases: ['furnacefilterscanada.com'],
    });
    expect(redirectsArtifact.hosts[FR_HOST]).toMatchObject({
      locale: 'fr',
      origin: `https://${FR_HOST}`,
      aliases: ['filtrationmontreal.com'],
    });
    expect(new Date(redirectsArtifact.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('le nom de l’interrupteur de sûreté est celui documenté', () => {
    expect(REDIRECTS_ENV_FLAG).toBe('REDIRECTS_ENABLED');
  });
});

describe('100 % des entrées de l’artefact', () => {
  for (const [host, table] of Object.entries(redirectsArtifact.hosts)) {
    const locale = table.locale as Locale;
    const allKeys = new Set([...Object.keys(table.exact), ...table.gone]);

    it(`${host} : chaque clé est normalisée et compatible avec le matcher du middleware`, () => {
      for (const key of allKeys) {
        expect(normalizeRedirectPath(key), key).toBe(key);
        // Le matcher n'atteint les chemins « à point » que via la règle .php :
        // une clé à point non-.php serait invisible du middleware.
        if (key.includes('.')) expect(key, key).toMatch(/\.php$/);
      }
    });

    it(`${host} : chaque redirection exacte résout en UNE 301 absolue, zéro chaîne, zéro boucle`, () => {
      for (const [key, entry] of Object.entries(table.exact) as Array<[string, RedirectEntry]>) {
        const resolution = resolveRedirect({ host, pathname: key, search: '' });
        expect(resolution, key).toEqual({
          kind: 'redirect',
          location: `${table.origin}${entry.to}`,
        });
        const normalizedTarget = normalizeRedirectPath(entry.to);
        expect(normalizedTarget, `boucle sur ${key}`).not.toBe(key);
        expect(allKeys.has(normalizedTarget), `chaîne : ${key} → ${entry.to}`).toBe(false);
      }
    });

    it(`${host} : chaque cible correspond à une route réelle de la vitrine (routing.ts)`, () => {
      const staticTargets = new Set<string>(['/sitemap.xml']);
      for (const key of Object.keys(routing.pathnames)) {
        if (key.includes('[')) continue;
        staticTargets.add(localizedPath(locale, key as LocalizedHref));
      }
      const templatePath = (pathname: string, params: Record<string, string>): string =>
        localizedPath(locale, { pathname, params } as LocalizedHref);
      const productBase = templatePath('/products/[slug]', { slug: 'x' }).slice(0, -1);
      const categoryBase = templatePath('/categories/[slug]', { slug: 'x' }).slice(0, -1);
      const sizeBase = templatePath('/sizes/[label]', { label: 'x' }).slice(0, -1);

      for (const entry of Object.values(table.exact) as RedirectEntry[]) {
        const target = entry.to;
        const ok =
          staticTargets.has(target) ||
          target.startsWith(productBase) ||
          target.startsWith(categoryBase) ||
          target.startsWith(sizeBase);
        expect(ok, `cible hors routage réel : ${target}`).toBe(true);
      }
    });

    it(`${host} : chaque 410 répond gone avec un corps localisé`, () => {
      for (const key of table.gone) {
        const resolution = resolveRedirect({ host, pathname: key, search: '' });
        expect(resolution, key).toEqual({ kind: 'gone', locale });
      }
      expect(goneResponseBody(locale)).toContain('noindex');
    });
  }
});

describe('comptabilité complète des inventaires', () => {
  const canonicalHost = (domain: string) => `www.${domain.replace(/^www\./, '')}`;

  it('chaque URL du CSV et du crawl est dans exactement un état', () => {
    const states = new Map<string, Set<string>>();
    for (const [host, table] of Object.entries(redirectsArtifact.hosts)) {
      const byState = new Map<string, string>();
      for (const key of Object.keys(table.exact)) byState.set(key, 'exact');
      for (const key of table.gone) {
        expect(byState.has(key), `exact ET 410 : ${host}${key}`).toBe(false);
        byState.set(key, 'gone');
      }
      states.set(host, new Set(byState.keys()));
    }
    const gapSet = new Set(ecarts.gaps.map((gap) => `${gap.host} ${gap.path}`));
    const ignoredSet = new Set(
      ecarts.ignored.map((row) => `${row.host} ${normalizeRedirectPath(row.path || '/')}`),
    );

    const rows = [
      ...readCsvRows('urls-bigcommerce.csv').map((cols) => ({
        domain: cols[0] ?? '',
        url: cols[2] ?? '',
      })),
      ...readCsvRows('urls-crawl.csv').map((cols) => ({
        domain: cols[0] ?? '',
        url: cols[2] ?? '',
      })),
    ];
    expect(rows.length).toBeGreaterThan(1800);

    for (const { domain, url } of rows) {
      const host = canonicalHost(domain);
      const table = redirectsArtifact.hosts[host];
      expect(table, `hôte inconnu : ${domain}`).toBeDefined();
      if (url.trim() === '') {
        // Pages BigCommerce sans URL publique : ignorées à bon droit.
        continue;
      }
      const normalized = normalizeRedirectPath(url.split(/[?#]/, 1)[0]!);
      const inTable = states.get(host)!.has(normalized);
      const inGaps = gapSet.has(`${host} ${normalized}`);
      const inIgnored = ignoredSet.has(`${host} ${normalized}`);
      const statuses = [inTable, inGaps, inIgnored].filter(Boolean).length;
      expect(statuses, `${host}${normalized} : ${statuses} état(s)`).toBe(1);
    }
  });

  it('affiche la couverture par hôte (rapport CI)', () => {
    const lines: string[] = ['Couverture des redirections (artefact commité) :'];
    for (const [host, byType] of Object.entries(redirectsArtifact.coverage.byHost)) {
      lines.push(`  ${host}`);
      for (const [type, cell] of Object.entries(byType)) {
        expect(cell.exact + cell.gone + cell.pending + cell.ignored).toBe(cell.total);
        lines.push(
          `    ${type.padEnd(8)} total=${cell.total} exactes=${cell.exact} 410=${cell.gone} en_attente=${cell.pending} ignorées=${cell.ignored}`,
        );
      }
    }
    console.info(lines.join('\n'));
  });
});

describe('variantes génériques (une seule 301, jamais deux)', () => {
  const [sampleKey, sampleEntry] = Object.entries(redirectsArtifact.hosts[EN_HOST]!.exact).find(
    ([, entry]) => (entry as RedirectEntry).type === 'product',
  )! as [string, RedirectEntry];
  const canonicalLocation = `https://${EN_HOST}${sampleEntry.to}`;

  it('casse, barre finale, doubles barres, paramètres de tri/pagination → même 301', () => {
    const variants = [sampleKey.toUpperCase() + '/', `${sampleKey}/`, `/${sampleKey}`, sampleKey];
    for (const variant of variants) {
      expect(resolveRedirect({ host: EN_HOST, pathname: variant, search: '' }), variant).toEqual({
        kind: 'redirect',
        location: canonicalLocation,
      });
    }
    expect(
      resolveRedirect({ host: EN_HOST, pathname: sampleKey, search: '?sort=bestselling&page=3' }),
    ).toEqual({ kind: 'redirect', location: canonicalLocation });
  });

  it('apex + http + casse → UNE 301 absolue vers la cible canonique', () => {
    expect(
      resolveRedirect({
        host: 'furnacefilterscanada.com',
        pathname: sampleKey.toUpperCase(),
        search: '',
        proto: 'http',
      }),
    ).toEqual({ kind: 'redirect', location: canonicalLocation });
  });

  it('les paramètres de suivi marketing suivent, les autres tombent', () => {
    expect(
      resolveRedirect({
        host: EN_HOST,
        pathname: sampleKey,
        search: '?sort=featured&utm_source=infolettre&gclid=abc&action=add',
      }),
    ).toEqual({
      kind: 'redirect',
      location: `${canonicalLocation}?utm_source=infolettre&gclid=abc`,
    });
  });

  it('search.php → page de recherche localisée, terme préservé dans q', () => {
    expect(
      resolveRedirect({
        host: EN_HOST,
        pathname: '/search.php',
        search: '?search_query=16x25x1&utm_campaign=x',
      }),
    ).toEqual({
      kind: 'redirect',
      location: `https://${EN_HOST}/search?q=16x25x1&utm_campaign=x`,
    });
    expect(
      resolveRedirect({ host: FR_HOST, pathname: '/Search.PHP', search: '?search_query=20x20x1' }),
    ).toEqual({ kind: 'redirect', location: `https://${FR_HOST}/recherche?q=20x20x1` });
  });

  it('apex avec chemin inconnu : 301 vers le même chemin sur l’hôte canonique', () => {
    expect(
      resolveRedirect({
        host: 'filtrationmontreal.com',
        pathname: '/nouvelle-page-quelconque',
        search: '?a=1',
      }),
    ).toEqual({
      kind: 'redirect',
      location: `https://${FR_HOST}/nouvelle-page-quelconque?a=1`,
    });
  });

  it('chemin inconnu sur hôte canonique en https : aucune redirection (404 normal)', () => {
    expect(
      resolveRedirect({
        host: EN_HOST,
        pathname: '/cette-page-n-a-jamais-existe',
        search: '',
        proto: 'https',
      }),
    ).toBeNull();
  });

  it('hôte hors périmètre : middleware inerte', () => {
    expect(
      resolveRedirect({ host: 'localhost:3000', pathname: '/m8-1056', search: '' }),
    ).toBeNull();
    expect(resolveRedirect({ host: null, pathname: '/m8-1056', search: '' })).toBeNull();
  });
});

describe('coût des pages courantes', () => {
  it('100 000 lookups manqués restent négligeables (tables en mémoire, O(1))', () => {
    const start = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      resolveRedirect({ host: EN_HOST, pathname: `/produit-inconnu-${i % 97}`, search: '' });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
});
