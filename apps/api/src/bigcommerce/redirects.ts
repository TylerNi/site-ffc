import type { PrismaClient } from '@prisma/client';
import {
  NOMINAL_FILTER_SIZES,
  normalizeRedirectPath,
  type Locale,
  type RedirectArtifact,
  type RedirectCoverage,
  type RedirectCoverageCell,
  type RedirectHostTable,
  type RedirectSourceType,
} from '@ffc/core';

/**
 * Construction de la table de redirections 301 (tâche 25) — logique PURE,
 * sans réseau ni base : le script CLI (`scripts/bigcommerce/redirects.ts`)
 * fournit les sources (CSV de la tâche 08 + crawl), les décisions versionnées
 * et les slugs actuels lus en base, et écrit l'artefact consommé par le
 * middleware de la vitrine.
 *
 * Principes du brief :
 *  - une URL source = UNE décision explicite (cible exacte, 410 assumé, ou
 *    écart en attente) — jamais de 301 par défaut vers l'accueil;
 *  - les cibles sont résolues À LA GÉNÉRATION (slug actuel en base) et
 *    vérifiées : zéro chaîne, zéro boucle, cible existante;
 *  - tout ce qui ne se résout pas sort dans le rapport d'écarts BLOQUANT.
 */

export interface RedirectSourceRow {
  /** Hôte canonique (`www.…`) auquel appartient l'URL. */
  host: string;
  type: RedirectSourceType;
  /** Chemin brut (sans hôte; une éventuelle query est ignorée à l'analyse). */
  path: string;
  /** identifiant_apparie (`en:34`, `fr:page:7`…) quand la source est le CSV. */
  matchedId?: string;
  origin: 'csv' | 'crawl';
}

export interface RedirectDecisionRow {
  host: string;
  path: string;
  action: 'redirect' | 'gone' | 'pending';
  /** Chemin cible localisé (obligatoire pour `redirect`). */
  to?: string;
  /** Justification versionnée (410 assumé, cible argumentée, ou blocage). */
  reason: string;
}

export interface RedirectHostConfig {
  host: string;
  locale: Locale;
  aliases: string[];
}

/** Slugs actuels lus en base — seuls les contenus SERVIS (200) sont inclus. */
export interface CatalogTargets {
  /** bigcommerceProductId → slug par locale (produits ACTIVE uniquement). */
  products: ReadonlyMap<string, Partial<Record<Locale, string>>>;
  /** bigcommerceCategoryId → slug par locale (catégories actives uniquement). */
  categories: ReadonlyMap<string, Partial<Record<Locale, string>>>;
  /** Étiquettes nominales du référentiel de tailles (`16x25x1`…). */
  sizeLabels: ReadonlySet<string>;
}

export interface RedirectGap {
  host: string;
  path: string;
  type: RedirectSourceType;
  id?: string;
  origin: 'csv' | 'crawl' | 'decision';
  reason: string;
}

export interface RedirectIgnored {
  host: string;
  path: string;
  type: RedirectSourceType;
  id?: string;
  reason: string;
}

export interface BuildRedirectsInput {
  hosts: RedirectHostConfig[];
  sources: RedirectSourceRow[];
  decisions: RedirectDecisionRow[];
  targets: CatalogTargets;
  generatedAt?: string;
}

export interface BuildRedirectsResult {
  artifact: RedirectArtifact;
  gaps: RedirectGap[];
  ignored: RedirectIgnored[];
}

/** Segments localisés des routes de la vitrine — miroir de
 *  `apps/web/src/i18n/routing.ts` (pathnames), verrouillé par le test
 *  `apps/web/src/redirects/redirects.test.ts` qui recroise chaque cible avec
 *  le routage réel. */
export const LOCALIZED_ROUTE_SEGMENTS: Record<
  Locale,
  { product: string; category: string; size: string; statics: readonly string[] }
> = {
  en: {
    product: '/products',
    category: '/categories',
    size: '/sizes',
    statics: ['/', '/search', '/cart', '/checkout', '/account/orders', '/sizes', '/sitemap.xml'],
  },
  fr: {
    product: '/produits',
    category: '/categories',
    size: '/tailles',
    statics: [
      '/',
      '/recherche',
      '/panier',
      '/caisse',
      '/compte/commandes',
      '/tailles',
      '/sitemap.xml',
    ],
  },
};

export function productPath(locale: Locale, slug: string): string {
  return `${LOCALIZED_ROUTE_SEGMENTS[locale].product}/${slug}`;
}

export function categoryPath(locale: Locale, slug: string): string {
  return `${LOCALIZED_ROUTE_SEGMENTS[locale].category}/${slug}`;
}

/**
 * Une cible est-elle une page réellement servie (200) par la vitrine pour
 * cette locale ? Statiques localisées, fiche produit/catégorie dont le slug
 * existe en base, page de taille du référentiel.
 */
export function isResolvableTarget(
  locale: Locale,
  target: string,
  targets: CatalogTargets,
): boolean {
  const segments = LOCALIZED_ROUTE_SEGMENTS[locale];
  if ((segments.statics as readonly string[]).includes(target)) return true;

  const productPrefix = `${segments.product}/`;
  if (target.startsWith(productPrefix)) {
    const slug = target.slice(productPrefix.length);
    for (const bySlug of targets.products.values()) {
      if (bySlug[locale] === slug) return true;
    }
    return false;
  }
  const categoryPrefix = `${segments.category}/`;
  if (target.startsWith(categoryPrefix)) {
    const slug = target.slice(categoryPrefix.length);
    for (const bySlug of targets.categories.values()) {
      if (bySlug[locale] === slug) return true;
    }
    return false;
  }
  const sizePrefix = `${segments.size}/`;
  if (target.startsWith(sizePrefix)) {
    return targets.sizeLabels.has(target.slice(sizePrefix.length));
  }
  return false;
}

/**
 * Cibles ACTUELLES lues en base : seuls les contenus réellement servis
 * (produits ACTIVE, catégories actives) deviennent des cibles de 301 — même
 * requête pour le CLI et le test d'intégration.
 */
export async function loadCatalogTargets(prisma: PrismaClient): Promise<CatalogTargets> {
  const products = new Map<string, Partial<Record<Locale, string>>>();
  for (const product of await prisma.product.findMany({
    where: { status: 'ACTIVE', bigcommerceProductId: { not: null } },
    select: {
      bigcommerceProductId: true,
      translations: { select: { locale: true, slug: true } },
    },
  })) {
    const byLocale: Partial<Record<Locale, string>> = {};
    for (const translation of product.translations) byLocale[translation.locale] = translation.slug;
    products.set(product.bigcommerceProductId!, byLocale);
  }

  const categories = new Map<string, Partial<Record<Locale, string>>>();
  for (const category of await prisma.category.findMany({
    where: { isActive: true, bigcommerceCategoryId: { not: null } },
    select: {
      bigcommerceCategoryId: true,
      translations: { select: { locale: true, slug: true } },
    },
  })) {
    const byLocale: Partial<Record<Locale, string>> = {};
    for (const translation of category.translations)
      byLocale[translation.locale] = translation.slug;
    categories.set(category.bigcommerceCategoryId!, byLocale);
  }

  return {
    products,
    categories,
    sizeLabels: new Set(NOMINAL_FILTER_SIZES.map((size) => size.nominal)),
  };
}

interface PendingEntry {
  key: string;
  to: string;
  type: RedirectSourceType;
  id?: string;
}

function emptyCell(): RedirectCoverageCell {
  return { total: 0, exact: 0, gone: 0, pending: 0, ignored: 0 };
}

/** Chemin d'une URL source, query et fragment retirés. */
function pathOnly(rawPath: string): string {
  return rawPath.split(/[?#]/, 1)[0] ?? rawPath;
}

export function buildRedirects(input: BuildRedirectsInput): BuildRedirectsResult {
  const hostConfigs = new Map(input.hosts.map((h) => [h.host, h]));
  const tables = new Map<string, RedirectHostTable>();
  for (const config of input.hosts) {
    tables.set(config.host, {
      locale: config.locale,
      origin: `https://${config.host}`,
      aliases: config.aliases,
      exact: {},
      gone: [],
    });
  }

  const gaps: RedirectGap[] = [];
  const ignored: RedirectIgnored[] = [];
  const errors: string[] = [];

  // --- Décisions indexées par (hôte, chemin normalisé); doublon = erreur.
  const decisionByKey = new Map<string, RedirectDecisionRow>();
  for (const decision of input.decisions) {
    if (!hostConfigs.has(decision.host)) {
      errors.push(`Décision sur hôte inconnu : ${decision.host}${decision.path}`);
      continue;
    }
    const key = `${decision.host} ${normalizeRedirectPath(pathOnly(decision.path))}`;
    if (decisionByKey.has(key)) {
      errors.push(`Décision en double : ${key}`);
      continue;
    }
    decisionByKey.set(key, decision);
  }

  // --- Sources dédupliquées par (hôte, chemin normalisé). Le CSV (types et
  //     identifiants appariés) prime sur le crawl pour la classification.
  interface MergedSource {
    host: string;
    path: string;
    normalized: string;
    type: RedirectSourceType;
    matchedId?: string;
    origin: 'csv' | 'crawl';
  }
  const merged = new Map<string, MergedSource>();
  for (const row of input.sources) {
    if (!hostConfigs.has(row.host)) {
      errors.push(`Source sur hôte inconnu : ${row.host}${row.path}`);
      continue;
    }
    const path = pathOnly(row.path);
    if (path.trim() === '') {
      ignored.push({
        host: row.host,
        path: row.path,
        type: row.type,
        id: row.matchedId,
        reason: 'URL vide côté BigCommerce (page sans chemin public) — rien à rediriger.',
      });
      continue;
    }
    const normalized = normalizeRedirectPath(path);
    const key = `${row.host} ${normalized}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { host: row.host, path, normalized, ...sourceMeta(row) });
    } else if (existing.origin === 'crawl' && row.origin === 'csv') {
      merged.set(key, { host: row.host, path, normalized, ...sourceMeta(row) });
    }
  }

  function sourceMeta(row: RedirectSourceRow): {
    type: RedirectSourceType;
    matchedId?: string;
    origin: 'csv' | 'crawl';
  } {
    return { type: row.type, matchedId: row.matchedId, origin: row.origin };
  }

  const coverage: RedirectCoverage = { byHost: {} };
  function cell(host: string, type: RedirectSourceType): RedirectCoverageCell {
    const byType = (coverage.byHost[host] ??= {});
    return (byType[type] ??= emptyCell());
  }

  const pendingEntries = new Map<string, PendingEntry[]>();
  for (const config of input.hosts) pendingEntries.set(config.host, []);
  const goneKeys = new Map<string, Set<string>>();
  for (const config of input.hosts) goneKeys.set(config.host, new Set());

  const consumedDecisions = new Set<string>();

  function applyDecision(
    decision: RedirectDecisionRow,
    source: { normalized: string; type: RedirectSourceType; id?: string },
  ): void {
    const host = decision.host;
    const locale = hostConfigs.get(host)!.locale;
    const stats = cell(host, source.type);
    if (decision.action === 'gone') {
      goneKeys.get(host)!.add(source.normalized);
      stats.gone += 1;
      return;
    }
    if (decision.action === 'pending') {
      gaps.push({
        host,
        path: source.normalized,
        type: source.type,
        id: source.id,
        origin: 'decision',
        reason: decision.reason,
      });
      stats.pending += 1;
      return;
    }
    if (!decision.to) {
      errors.push(`Décision redirect sans cible : ${host}${decision.path}`);
      return;
    }
    if (!isResolvableTarget(locale, decision.to, input.targets)) {
      errors.push(
        `Cible de décision introuvable sur la vitrine (${locale}) : ${host}${decision.path} → ${decision.to}`,
      );
      return;
    }
    pendingEntries.get(host)!.push({
      key: source.normalized,
      to: decision.to,
      type: source.type,
      id: source.id,
    });
    stats.exact += 1;
  }

  for (const source of merged.values()) {
    const config = hostConfigs.get(source.host)!;
    const locale = config.locale;
    const stats = cell(source.host, source.type);
    stats.total += 1;

    // Racine et fichiers servis à l'identique par la nouvelle plateforme.
    if (['/', '/robots.txt', '/sitemap.xml'].includes(source.normalized)) {
      ignored.push({
        host: source.host,
        path: source.normalized,
        type: source.type,
        id: source.matchedId,
        reason: 'URL identique sur la nouvelle plateforme — aucune redirection nécessaire.',
      });
      stats.ignored += 1;
      continue;
    }

    const decisionKey = `${source.host} ${source.normalized}`;
    const decision = decisionByKey.get(decisionKey);
    if (decision) {
      consumedDecisions.add(decisionKey);
      applyDecision(decision, {
        normalized: source.normalized,
        type: source.type,
        id: source.matchedId,
      });
      continue;
    }

    // Résolution par identifiant apparié (produits / catégories importés).
    if (source.type === 'product' || source.type === 'category') {
      const map = source.type === 'product' ? input.targets.products : input.targets.categories;
      const slugByLocale = source.matchedId ? map.get(source.matchedId) : undefined;
      if (!source.matchedId) {
        gaps.push({
          host: source.host,
          path: source.normalized,
          type: source.type,
          origin: source.origin,
          reason:
            'URL découverte hors CSV (crawl) sans identifiant BigCommerce apparié — à croiser manuellement.',
        });
        stats.pending += 1;
        continue;
      }
      if (!slugByLocale) {
        gaps.push({
          host: source.host,
          path: source.normalized,
          type: source.type,
          id: source.matchedId,
          origin: source.origin,
          reason:
            'Identifiant BigCommerce absent de la base (import non exécuté pour cette vitrine, ou contenu masqué).',
        });
        stats.pending += 1;
        continue;
      }
      const slug = slugByLocale[locale];
      if (!slug) {
        gaps.push({
          host: source.host,
          path: source.normalized,
          type: source.type,
          id: source.matchedId,
          origin: source.origin,
          reason: `Traduction ${locale} manquante en base — cible localisée impossible.`,
        });
        stats.pending += 1;
        continue;
      }
      const to = source.type === 'product' ? productPath(locale, slug) : categoryPath(locale, slug);
      pendingEntries.get(source.host)!.push({
        key: source.normalized,
        to,
        type: source.type,
        id: source.matchedId,
      });
      stats.exact += 1;
      continue;
    }

    // Pages CMS, blogue, marques, autres : décision explicite obligatoire.
    gaps.push({
      host: source.host,
      path: source.normalized,
      type: source.type,
      id: source.matchedId,
      origin: source.origin,
      reason:
        source.type === 'blog'
          ? 'Billet de blogue — décision requise (reprise en page statique ou 301 argumentée; jamais vers l’accueil).'
          : source.type === 'brand'
            ? 'Page de marque BigCommerce — aucune route équivalente sur la vitrine; décision requise (410 assumé ou cible argumentée).'
            : source.type === 'page'
              ? 'Page CMS BigCommerce — décision requise (cible argumentée ou 410 assumé).'
              : 'URL découverte au crawl hors inventaire CSV — décision requise (cible argumentée ou 410 assumé).',
    });
    stats.pending += 1;
  }

  // Décisions orphelines (chemin absent des sources) : appliquées quand même
  // — elles couvrent des URLs système connues (cart.php…) qui ne figurent ni
  // au CSV ni aux sitemaps mais existent sur les deux vitrines.
  for (const [key, decision] of decisionByKey) {
    if (consumedDecisions.has(key)) continue;
    const normalized = normalizeRedirectPath(pathOnly(decision.path));
    cell(decision.host, 'other').total += 1;
    applyDecision(decision, { normalized, type: 'other' });
  }

  // --- Assemblage + vérifications zéro chaîne / zéro boucle / zéro conflit.
  for (const config of input.hosts) {
    const table = tables.get(config.host)!;
    const entries = pendingEntries.get(config.host)!;
    const gone = goneKeys.get(config.host)!;
    const byKey = new Map<string, PendingEntry>();
    for (const entry of entries) {
      const existing = byKey.get(entry.key);
      if (existing && existing.to !== entry.to) {
        errors.push(
          `Conflit de cible pour ${config.host}${entry.key} : ${existing.to} ≠ ${entry.to}`,
        );
        continue;
      }
      byKey.set(entry.key, entry);
    }
    for (const [key, entry] of byKey) {
      if (gone.has(key)) {
        errors.push(`${config.host}${key} est à la fois redirigé et 410.`);
        continue;
      }
      const normalizedTarget = normalizeRedirectPath(entry.to);
      if (normalizedTarget === key) {
        errors.push(`Boucle : ${config.host}${key} → ${entry.to}`);
        continue;
      }
      if (byKey.has(normalizedTarget) || gone.has(normalizedTarget)) {
        errors.push(`Chaîne : ${config.host}${key} → ${entry.to} (cible elle-même redirigée)`);
        continue;
      }
      table.exact[key] = { to: entry.to, type: entry.type, ...(entry.id ? { id: entry.id } : {}) };
    }
    table.gone = [...gone].sort();
    table.exact = Object.fromEntries(
      Object.entries(table.exact).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  if (errors.length > 0) {
    throw new Error(`Génération des redirections refusée :\n - ${errors.join('\n - ')}`);
  }

  const artifact: RedirectArtifact = {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sources: {
      csvRows: input.sources.filter((s) => s.origin === 'csv').length,
      crawlRows: input.sources.filter((s) => s.origin === 'crawl').length,
      decisions: input.decisions.length,
    },
    hosts: Object.fromEntries(tables),
    coverage,
  };

  return { artifact, gaps: sortRows(gaps), ignored: sortRows(ignored) };
}

function sortRows<T extends { host: string; path: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path));
}
