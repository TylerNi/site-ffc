import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { type Locale } from '@ffc/i18n';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { FiltersForm } from '@/components/FiltersForm';
import { ProductGrid } from '@/components/ProductCard';
import { CatalogUnavailable, CursorPager, NoResults, ResultCount } from '@/components/listing';
import { getCategories, getSitemapData, listProducts } from '@/lib/api';
import {
  filtersToQuery,
  hasActiveFilters,
  parseListingFilters,
  type SearchParams,
} from '@/lib/listing';
import { pageMetadata } from '@/lib/seo';
import { type LocalizedHref, localizedPath } from '@/lib/site';

/**
 * Page catégorie : filtres combinables par formulaire GET (crawlable) et
 * pagination par curseur. Rendu dynamique (searchParams), mais chaque fetch
 * passe par le cache de données de Next — le TTFB reste bas.
 */

interface CategoryNode {
  slug: string;
  name: string;
  description?: string | null;
  productCount: number;
  children: CategoryNode[];
}

/** Cherche une catégorie (et son parent) dans l'arbre localisé. */
function findCategory(
  nodes: CategoryNode[],
  slug: string,
  parent: CategoryNode | null = null,
): { node: CategoryNode; parent: CategoryNode | null } | null {
  for (const node of nodes) {
    if (node.slug === slug) return { node, parent };
    const found = findCategory(node.children, slug, node);
    if (found) return found;
  }
  return null;
}

/** Slugs fr/en de la catégorie (hreflang) via l'endpoint sitemap (caché). */
async function categoryHrefs(
  slug: string,
  locale: Locale,
): Promise<Partial<Record<Locale, LocalizedHref>>> {
  const data = await getSitemapData();
  if (!data || data === 'not-found') {
    return { [locale]: { pathname: '/categories/[slug]', params: { slug } } };
  }
  const match = data.categories.find((category) => category.slugs[locale] === slug);
  const href = (s: string | null | undefined): LocalizedHref | undefined =>
    s ? { pathname: '/categories/[slug]', params: { slug: s } } : undefined;
  if (!match) return { [locale]: href(slug) };
  return { fr: href(match.slugs.fr), en: href(match.slugs.en) };
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { locale, slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const filters = parseListingFilters(await searchParams);

  const categories = await getCategories(locale);
  if (!categories || categories === 'not-found') return {};
  const found = findCategory(categories.categories, slug);
  if (!found) return {};

  const t = await getTranslations({ locale, namespace: 'web.meta' });
  const metadata = pageMetadata({
    locale,
    hrefs: await categoryHrefs(slug, locale),
    title: found.node.name,
    description:
      found.node.description ?? t('categoryFallbackDescription', { name: found.node.name }),
    // Les variantes filtrées/paginées ne s'indexent pas; leur canonical
    // pointe déjà la version nue de la catégorie.
    noindex: hasActiveFilters(filters),
  });
  return metadata;
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale, slug: rawSlug } = await params;
  setRequestLocale(locale);
  const slug = decodeURIComponent(rawSlug);
  const filters = parseListingFilters(await searchParams);

  const [categories, products] = await Promise.all([
    getCategories(locale),
    listProducts(locale, { ...filters, category: slug, limit: 24 }),
  ]);

  if (products === 'not-found') notFound();
  const found =
    categories && categories !== 'not-found' ? findCategory(categories.categories, slug) : null;
  if (categories && categories !== 'not-found' && !found) notFound();

  const t = await getTranslations({ locale, namespace: 'web' });
  const basePath = localizedPath(locale, { pathname: '/categories/[slug]', params: { slug } });

  return (
    <main className="main container">
      <Breadcrumbs
        locale={locale}
        items={[
          { name: t('breadcrumb.home'), href: '/' },
          ...(found?.parent
            ? [
                {
                  name: found.parent.name,
                  href: {
                    pathname: '/categories/[slug]',
                    params: { slug: found.parent.slug },
                  } as LocalizedHref,
                },
              ]
            : []),
          { name: found?.node.name ?? slug },
        ]}
      />

      <h1>{found?.node.name ?? slug}</h1>
      {found?.node.description && (
        <p className="muted" style={{ maxWidth: '46rem' }}>
          {found.node.description}
        </p>
      )}

      <FiltersForm locale={locale} action={basePath} filters={filters} />

      {!products ? (
        <CatalogUnavailable locale={locale} />
      ) : products.items.length === 0 ? (
        <NoResults locale={locale} />
      ) : (
        <>
          <ResultCount locale={locale} count={products.count} hasMore={products.hasMore} />
          <ProductGrid products={products.items} locale={locale} priorityCount={4} />
          <CursorPager
            locale={locale}
            basePath={basePath}
            query={filtersToQuery(filters)}
            nextCursor={products.nextCursor}
            isPaginated={Boolean(filters.cursor)}
          />
        </>
      )}
    </main>
  );
}
