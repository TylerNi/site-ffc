import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { FiltersForm } from '@/components/FiltersForm';
import { ProductGrid } from '@/components/ProductCard';
import { CatalogUnavailable, CursorPager, ResultCount } from '@/components/listing';
import { Link } from '@/i18n/navigation';
import { getSizeIndex, searchProducts } from '@/lib/api';
import { filtersToQuery, parseListingFilters, type SearchParams } from '@/lib/listing';
import { pageMetadata } from '@/lib/seo';
import { localizedPath } from '@/lib/site';

/**
 * Recherche plein texte — rendue serveur, jamais indexée (noindex + robots
 * Disallow). La tolérance aux fautes et la normalisation des dimensions
 * viennent de l'API (tâche 06).
 */

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { locale } = await params;
  const q = firstParam((await searchParams).q);
  const t = await getTranslations({ locale, namespace: 'web.meta' });

  const href = q ? ({ pathname: '/search', query: { q } } as const) : ('/search' as const);

  return pageMetadata({
    locale,
    hrefs: { fr: href, en: href },
    title: t('searchTitle'),
    noindex: true,
  });
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const awaited = await searchParams;
  const q = firstParam(awaited.q).slice(0, 120);
  const filters = parseListingFilters(awaited);

  const t = await getTranslations({ locale, namespace: 'web' });
  const basePath = localizedPath(locale, '/search');

  const results = q ? await searchProducts(locale, q, { ...filters, limit: 24 }) : undefined;

  // Sans requête : proposer les tailles populaires plutôt qu'une page vide.
  const sizeIndex = q ? null : await getSizeIndex();
  const popularSizes =
    sizeIndex && sizeIndex !== 'not-found'
      ? [...sizeIndex.sizes].sort((a, b) => b.productCount - a.productCount).slice(0, 12)
      : [];

  return (
    <main className="main container">
      <Breadcrumbs
        locale={locale}
        items={[{ name: t('breadcrumb.home'), href: '/' }, { name: t('breadcrumb.search') }]}
      />

      <h1>{q ? t('search.resultsFor', { query: q }) : t('search.title')}</h1>
      <p className="muted small">{t('search.tip')}</p>

      {q && (
        <FiltersForm
          locale={locale}
          action={basePath}
          filters={filters}
          hidden={{ q }}
          showDimension={false}
        />
      )}

      {!q ? (
        <>
          <p>{t('search.empty')}</p>
          {popularSizes.length > 0 && (
            <div className="pill-row">
              {popularSizes.map((size) => (
                <Link
                  key={size.label}
                  className="pill"
                  href={{ pathname: '/sizes/[label]', params: { label: size.label } }}
                >
                  {size.label}
                </Link>
              ))}
            </div>
          )}
        </>
      ) : results === null ? (
        <CatalogUnavailable locale={locale} />
      ) : results === 'not-found' || !results || results.items.length === 0 ? (
        <div className="empty-state">
          <p>{t('search.noResults', { query: q })}</p>
          <p className="small">{t('listing.noResultsTip')}</p>
        </div>
      ) : (
        <>
          <ResultCount locale={locale} count={results.count} hasMore={results.hasMore} />
          <ProductGrid products={results.items} locale={locale} priorityCount={4} />
          <CursorPager
            locale={locale}
            basePath={basePath}
            query={{ q, ...filtersToQuery(filters) }}
            nextCursor={results.nextCursor}
            isPaginated={Boolean(filters.cursor)}
          />
        </>
      )}
    </main>
  );
}
