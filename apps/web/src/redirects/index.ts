import {
  isTrackingParam,
  normalizeRedirectPath,
  type Locale,
  type RedirectArtifact,
  type RedirectEntry,
  type RedirectHostTable,
} from '@ffc/core';
import { routing } from '../i18n/routing';
import artifactJson from './redirects.generated.json';

/**
 * Résolution des redirections 301 de bascule (tâche 25) — côté vitrine.
 *
 * L'artefact `redirects.generated.json` est produit par
 * `pnpm --filter @ffc/api bigcommerce:redirects` et versionné : le middleware
 * ne fait AUCUN calcul au runtime, seulement des lookups O(1) sur des Maps
 * construites une fois au chargement du module. Une URL inconnue coûte une
 * normalisation de chaîne et deux lookups — négligeable sur les pages
 * courantes.
 *
 * Fonctions pures (entrée = hôte/chemin/query), testables sans Request.
 */

export const redirectsArtifact = artifactJson as unknown as RedirectArtifact;

interface PreparedHost extends RedirectHostTable {
  gone: string[];
  goneSet: Set<string>;
}

const tables = new Map<string, PreparedHost>();
const aliasToCanonical = new Map<string, string>();
for (const [host, table] of Object.entries(redirectsArtifact.hosts)) {
  const key = host.toLowerCase();
  tables.set(key, { ...table, goneSet: new Set(table.gone) });
  aliasToCanonical.set(key, key);
  for (const alias of table.aliases) aliasToCanonical.set(alias.toLowerCase(), key);
}

export type RedirectResolution =
  { kind: 'redirect'; location: string } | { kind: 'gone'; locale: Locale };

export interface RedirectRequestInput {
  /** En-tête Host (éventuellement avec port), ou null si absent. */
  host: string | null;
  /** Chemin brut de la requête (percent-encodé). */
  pathname: string;
  /** Query brute, `?` compris (ou chaîne vide). */
  search: string;
  /** En-tête x-forwarded-proto (`http` force une 301 vers https). */
  proto?: string | null;
}

/** Segment localisé de la page de recherche, lu du routage réel. */
function searchPath(locale: Locale): string {
  const pathname = routing.pathnames['/search'];
  return typeof pathname === 'string' ? pathname : pathname[locale];
}

/**
 * Query de la cible : paramètres de suivi marketing préservés, tout le reste
 * (tri, pagination, facettes BigCommerce…) abandonné — la cible est la page
 * canonique. `extra` (ex. `q` de la recherche) passe en tête.
 */
function targetQuery(search: string, extra?: readonly [string, string]): string {
  const kept = new URLSearchParams();
  if (extra) kept.set(extra[0], extra[1]);
  for (const [name, value] of new URLSearchParams(search)) {
    if (isTrackingParam(name)) kept.append(name, value);
  }
  const qs = kept.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Décide du sort d'une requête entrante :
 *
 *  - entrée exacte de la table → 301 absolue vers l'origine canonique (les
 *    variantes casse/slash/params/apex/http aboutissent en UNE seule 301);
 *  - `search.php?search_query=…` → page de recherche localisée, terme
 *    préservé dans `?q=`;
 *  - chemin abandonné → 410;
 *  - chemin inconnu sur un hôte alias ou en http → 301 vers la même URL sur
 *    l'origine canonique (chemin et query préservés tels quels);
 *  - sinon `null` : la requête suit son cours normal (next-intl).
 */
export function resolveRedirect(input: RedirectRequestInput): RedirectResolution | null {
  if (!input.host) return null;
  const hostname = (input.host.split(':', 1)[0] ?? input.host).toLowerCase();
  const canonicalHost = aliasToCanonical.get(hostname);
  if (!canonicalHost) return null;
  const table = tables.get(canonicalHost)!;

  const normalized = normalizeRedirectPath(input.pathname);

  if (normalized === '/search.php') {
    const term = new URLSearchParams(input.search).get('search_query');
    const to = searchPath(table.locale);
    return {
      kind: 'redirect',
      location: `${table.origin}${to}${targetQuery(input.search, term ? ['q', term] : undefined)}`,
    };
  }

  const entry: RedirectEntry | undefined = table.exact[normalized];
  if (entry) {
    return { kind: 'redirect', location: `${table.origin}${entry.to}${targetQuery(input.search)}` };
  }
  if (table.goneSet.has(normalized)) {
    return { kind: 'gone', locale: table.locale };
  }

  if (hostname !== canonicalHost || input.proto === 'http') {
    return { kind: 'redirect', location: `${table.origin}${input.pathname}${input.search}` };
  }
  return null;
}

/** Corps HTML minimal (localisé, noindex) des réponses 410. */
export function goneResponseBody(locale: Locale): string {
  const fr = locale === 'fr';
  const title = fr ? 'Page retirée' : 'Page removed';
  const message = fr
    ? 'Cette page a été retirée définitivement lors de la migration de la boutique.'
    : 'This page was permanently removed when the store moved to its new platform.';
  const home = fr ? 'Retour à l’accueil' : 'Back to the home page';
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    `<title>${title}</title><meta name="robots" content="noindex"></head>` +
    `<body><h1>${title}</h1><p>${message}</p><p><a href="/">${home}</a></p></body></html>`
  );
}
