import { createApiClient, type paths } from '@ffc/api-client';
import { type Locale } from '@ffc/i18n';

/**
 * Accès serveur à l'API catalogue, avec le cache de données de Next :
 * chaque lecture porte un `revalidate` aligné sur les en-têtes Cache-Control
 * de l'API (tâche 06). Les pages ISR se reconstruisent à partir de ces
 * fetchs — jamais d'appel client sauf l'autocomplétion.
 *
 * Contrat d'erreur : `null` = API indisponible (les pages affichent un état
 * dégradé qui se régénère), `'not-found'` = 404 franc (la page fait un 404).
 */

type Json<T extends keyof paths> = paths[T] extends {
  get: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type CategoryTree = Json<'/v1/catalog/categories'>;
export type ProductList = Json<'/v1/catalog/products'>;
export type ProductListItem = ProductList['items'][number];
export type ProductDetail = Json<'/v1/catalog/products/{slug}'>;
export type SizeIndex = Json<'/v1/catalog/sizes'>;
export type SizeEquivalents = Json<'/v1/catalog/sizes/{label}/equivalents'>;
export type SitemapData = Json<'/v1/catalog/sitemap'>;
export type Suggestions = Json<'/v1/catalog/search/suggest'>;

/** Durées de revalidation ISR (secondes), alignées sur le cache de l'API. */
export const REVALIDATE = {
  home: 600,
  product: 300,
  listing: 120,
  sizes: 3600,
  size: 600,
  search: 30,
  sitemap: 3600,
} as const;

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const client = createApiClient({ baseUrl: API_URL });

/** Filtres de liste exposés dans les URL de la vitrine. */
export interface ListingFilters {
  dimension?: string;
  merv?: number;
  depth?: number;
  inStock?: boolean;
  sort?: 'relevance' | 'price' | 'popularity';
  cursor?: string;
  limit?: number;
  category?: string;
  brand?: string;
}

/** Résultat d'un appel : donnée, 404 franc, ou API injoignable. */
type Result<T> = T | 'not-found' | null;

async function call<T>(fn: () => Promise<{ data?: T; response: Response }>): Promise<Result<T>> {
  try {
    const { data, response } = await fn();
    if (data !== undefined) return data;
    if (response.status === 404 || response.status === 400) return 'not-found';
    return null;
  } catch {
    // API éteinte, DNS, timeout — l'appelant dégrade sans casser le build.
    return null;
  }
}

export function getCategories(locale: Locale): Promise<Result<CategoryTree>> {
  return call(() =>
    client.GET('/v1/catalog/categories', {
      params: { query: { locale } },
      next: { revalidate: REVALIDATE.listing },
    }),
  );
}

export function listProducts(
  locale: Locale,
  filters: ListingFilters = {},
): Promise<Result<ProductList>> {
  return call(() =>
    client.GET('/v1/catalog/products', {
      params: { query: { locale, ...filters } },
      next: { revalidate: REVALIDATE.listing },
    }),
  );
}

export function getProduct(slug: string, locale: Locale): Promise<Result<ProductDetail>> {
  return call(() =>
    client.GET('/v1/catalog/products/{slug}', {
      params: { path: { slug }, query: { locale } },
      next: { revalidate: REVALIDATE.product },
    }),
  );
}

export function getSizeIndex(): Promise<Result<SizeIndex>> {
  return call(() => client.GET('/v1/catalog/sizes', { next: { revalidate: REVALIDATE.sizes } }));
}

export function getSizeEquivalents(label: string): Promise<Result<SizeEquivalents>> {
  return call(() =>
    client.GET('/v1/catalog/sizes/{label}/equivalents', {
      params: { path: { label } },
      next: { revalidate: REVALIDATE.size },
    }),
  );
}

export function searchProducts(
  locale: Locale,
  q: string,
  filters: ListingFilters = {},
): Promise<Result<ProductList>> {
  return call(() =>
    client.GET('/v1/catalog/search', {
      params: { query: { locale, q, ...filters } },
      next: { revalidate: REVALIDATE.search },
    }),
  );
}

export function getSitemapData(): Promise<Result<SitemapData>> {
  return call(() =>
    client.GET('/v1/catalog/sitemap', { next: { revalidate: REVALIDATE.sitemap } }),
  );
}
