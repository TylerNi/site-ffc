import { type ListingFilters } from './api';

/**
 * Aller-retour entre les query strings des pages de liste et les filtres de
 * l'API. Valeurs invalides ignorées silencieusement (l'API validerait de
 * toute façon) — une URL bricolée ne casse jamais la page.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toInt(value: string | undefined, min: number, max: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

const SORTS = new Set(['relevance', 'price', 'popularity']);

export function parseListingFilters(params: SearchParams): ListingFilters {
  const sortRaw = first(params.sort);
  const dimension = first(params.dimension)?.slice(0, 40).trim();
  const cursor = first(params.cursor)?.slice(0, 512);

  return {
    dimension: dimension || undefined,
    merv: toInt(first(params.merv), 1, 20),
    depth: toInt(first(params.depth), 1, 12),
    inStock: first(params.inStock) === 'true' ? true : undefined,
    sort: sortRaw && SORTS.has(sortRaw) ? (sortRaw as ListingFilters['sort']) : undefined,
    cursor: cursor || undefined,
  };
}

/** Query string (sans curseur) à conserver dans les liens de pagination. */
export function filtersToQuery(filters: ListingFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.dimension) query.dimension = filters.dimension;
  if (filters.merv !== undefined) query.merv = String(filters.merv);
  if (filters.depth !== undefined) query.depth = String(filters.depth);
  if (filters.inStock) query.inStock = 'true';
  if (filters.sort) query.sort = filters.sort;
  return query;
}

/** true si l'URL porte un filtre ou un curseur (⇒ variante non indexable). */
export function hasActiveFilters(filters: ListingFilters): boolean {
  return Boolean(
    filters.dimension ??
    filters.merv ??
    filters.depth ??
    filters.inStock ??
    filters.cursor ??
    (filters.sort && filters.sort !== 'relevance'),
  );
}
