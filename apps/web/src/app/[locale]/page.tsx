import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { SearchBox } from '@/components/SearchBox';
import { ProductGrid } from '@/components/ProductCard';
import { CatalogUnavailable } from '@/components/listing';
import { Link } from '@/i18n/navigation';
import { getCategories, getSizeIndex, listProducts } from '@/lib/api';
import { pageMetadata } from '@/lib/seo';
import { localizedPath } from '@/lib/site';

export const revalidate = 600;

const CLIENT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.meta' });
  return {
    ...pageMetadata({
      locale,
      hrefs: { fr: '/', en: '/' },
      title: t('homeTitle'),
      description: t('homeDescription'),
    }),
    // L'accueil garde le nom du site en tête (pas le gabarit « %s · site »).
    title: `${t('siteName')} — ${t('homeTitle')}`,
  };
}

export default async function HomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web' });

  const [featured, sizeIndex, categories] = await Promise.all([
    listProducts(locale, { limit: 8 }),
    getSizeIndex(),
    getCategories(locale),
  ]);
  const unavailable = featured === null && sizeIndex === null && categories === null;

  const popularSizes =
    sizeIndex && sizeIndex !== 'not-found'
      ? [...sizeIndex.sizes].sort((a, b) => b.productCount - a.productCount).slice(0, 12)
      : [];
  const rootCategories = categories && categories !== 'not-found' ? categories.categories : [];

  return (
    <main className="main" style={{ paddingTop: 0 }}>
      <section className="hero">
        <div className="container hero-inner">
          <h1>{t('home.heroTitle')}</h1>
          <p>{t('home.heroSubtitle')}</p>
          <SearchBox
            locale={locale}
            searchPath={localizedPath(locale, '/search')}
            sizesBasePath={localizedPath(locale, '/sizes')}
            productsBasePath={localizedPath(locale, {
              pathname: '/products/[slug]',
              params: { slug: '_' },
            }).replace(/\/_$/, '')}
            apiUrl={CLIENT_API_URL}
            labels={{
              label: t('header.searchLabel'),
              placeholder: t('header.searchPlaceholder'),
              submit: t('header.searchSubmit'),
              sizes: t('header.suggestSizes'),
              products: t('header.suggestProducts'),
              suggestions: t('a11y.searchSuggestions'),
            }}
          />
          <p className="hero-hint">{t('home.heroHint')}</p>
        </div>
      </section>

      <div className="container">
        {unavailable && (
          <section className="section">
            <CatalogUnavailable locale={locale} />
          </section>
        )}

        {popularSizes.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2>{t('home.popularSizes')}</h2>
              <Link href="/sizes">{t('home.allSizes')}</Link>
            </div>
            <div className="pill-row">
              {popularSizes.map((size) => (
                <Link
                  key={size.label}
                  className="pill"
                  href={{ pathname: '/sizes/[label]', params: { label: size.label } }}
                >
                  {size.label}
                  <span className="muted">
                    {t('home.productCount', { count: size.productCount })}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {featured && featured !== 'not-found' && featured.items.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2>{t('home.featured')}</h2>
            </div>
            <ProductGrid products={featured.items} locale={locale} priorityCount={4} />
          </section>
        )}

        {rootCategories.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2>{t('home.categories')}</h2>
            </div>
            <div className="pill-row">
              {rootCategories
                .flatMap((root) => [root, ...root.children])
                .map((category) => (
                  <Link
                    key={category.slug}
                    className="pill"
                    href={{ pathname: '/categories/[slug]', params: { slug: category.slug } }}
                  >
                    {category.name}
                    <span className="muted">
                      {t('home.productCount', { count: category.productCount })}
                    </span>
                  </Link>
                ))}
            </div>
          </section>
        )}

        <section className="section usp-row">
          <div className="usp">
            <h3>{t('home.usp.shippingTitle')}</h3>
            <p>{t('home.usp.shippingText')}</p>
          </div>
          <div className="usp">
            <h3>{t('home.usp.sizesTitle')}</h3>
            <p>{t('home.usp.sizesText')}</p>
          </div>
          <div className="usp">
            <h3>{t('home.usp.mervTitle')}</h3>
            <p>{t('home.usp.mervText')}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
