import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { type Locale } from '@ffc/i18n';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ProductGrid } from '@/components/ProductCard';
import { Link, permanentRedirect } from '@/i18n/navigation';
import { getSizeEquivalents, getSizeIndex, listProducts } from '@/lib/api';
import { formatDimensions, formatList } from '@/lib/format';
import { pageMetadata } from '@/lib/seo';

export const revalidate = 600;
export const dynamicParams = true;

/**
 * Pages SEO par taille — la porte d'entrée organique du marché (« filtre
 * fournaise 16x25x1 »). Toutes les tailles du catalogue sont pré-rendues;
 * une graphie non canonique (« 15 3/4 x 24 3/4 x 3/4 », « 25x16x1 ») fait
 * une redirection 308 vers la taille nominale canonique.
 */
export async function generateStaticParams(): Promise<Array<{ label: string }>> {
  const index = await getSizeIndex();
  if (!index || index === 'not-found') return [];
  return index.sizes.map((size) => ({ label: size.label }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; label: string }>;
}): Promise<Metadata> {
  const { locale, label: rawLabel } = await params;
  const label = decodeURIComponent(rawLabel);
  const equivalents = await getSizeEquivalents(label);
  if (!equivalents || equivalents === 'not-found') return {};

  const t = await getTranslations({ locale, namespace: 'web.meta' });
  const index = await getSizeIndex();
  const size =
    index && index !== 'not-found'
      ? index.sizes.find((s) => s.label === equivalents.canonical)
      : undefined;
  const actual = equivalents.equivalents.find((e) => e.label === equivalents.canonical)?.actual;

  const href = {
    pathname: '/sizes/[label]',
    params: { label: equivalents.canonical },
  } as const;

  return pageMetadata({
    locale,
    hrefs: { fr: href, en: href },
    title: t('sizeTitle', { label: equivalents.canonical }),
    description: t('sizeDescription', {
      label: equivalents.canonical,
      mervList: size ? formatList(size.mervValues, locale) : 'MERV',
      actual: actual ? formatDimensions(actual, locale) : '—',
    }),
  });
}

export default async function SizePage({
  params,
}: {
  params: Promise<{ locale: Locale; label: string }>;
}) {
  const { locale, label: rawLabel } = await params;
  setRequestLocale(locale);
  const label = decodeURIComponent(rawLabel);

  const equivalents = await getSizeEquivalents(label);
  if (equivalents === 'not-found') notFound();
  if (!equivalents) throw new Error('Catalogue indisponible');

  // Graphie non canonique (espaces, réel, orientation) → URL canonique.
  if (equivalents.canonical !== label) {
    permanentRedirect({
      href: { pathname: '/sizes/[label]', params: { label: equivalents.canonical } },
      locale,
    });
  }

  const [products, index] = await Promise.all([
    listProducts(locale, { dimension: equivalents.canonical, limit: 60 }),
    getSizeIndex(),
  ]);
  if (products === 'not-found' || (products && products.items.length === 0)) notFound();
  if (!products) throw new Error('Catalogue indisponible');

  const t = await getTranslations({ locale, namespace: 'web' });

  const sizes = index && index !== 'not-found' ? index.sizes : [];
  const current = sizes.find((s) => s.label === equivalents.canonical);
  const actual = equivalents.equivalents.find((e) => e.label === equivalents.canonical)?.actual;

  // Autres épaisseurs de la même face (16x25x1 → 16x25x4, 16x25x5).
  const siblings = current
    ? sizes.filter(
        (s) =>
          s.label !== current.label && s.width === current.width && s.height === current.height,
      )
    : [];

  // Autres tailles du catalogue couvertes par la même saisie (équivalences).
  const otherEquivalents = equivalents.equivalents.filter(
    (e) => e.inCatalog && e.label !== equivalents.canonical,
  );

  return (
    <main className="main container">
      <Breadcrumbs
        locale={locale}
        items={[
          { name: t('breadcrumb.home'), href: '/' },
          { name: t('breadcrumb.sizes'), href: '/sizes' },
          { name: equivalents.canonical },
        ]}
      />

      <h1>{t('size.title', { label: equivalents.canonical })}</h1>
      <p className="muted">
        {t('size.intro', {
          count: products.items.length,
          label: equivalents.canonical,
          mervList: current ? formatList(current.mervValues, locale) : '—',
        })}
      </p>

      {actual && (
        <div className="info-box" style={{ maxWidth: '46rem' }}>
          {t('size.actualNote', {
            label: equivalents.canonical,
            actual: formatDimensions(actual, locale),
          })}
        </div>
      )}

      {current && current.mervValues.length > 0 && (
        <section className="section">
          <h2>{t('size.mervAvailable')}</h2>
          <div className="pill-row">
            {current.mervValues.map((merv) => (
              <Link
                key={merv}
                className="pill"
                href={{
                  pathname: '/search',
                  query: { q: equivalents.canonical, merv: String(merv) },
                }}
              >
                {t('product.merv', { merv })}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>{t('size.products', { label: equivalents.canonical })}</h2>
        </div>
        <ProductGrid products={products.items} locale={locale} priorityCount={4} />
      </section>

      {siblings.length > 0 && (
        <section className="section">
          <h2>{t('size.siblings')}</h2>
          <div className="pill-row">
            {siblings.map((size) => (
              <Link
                key={size.label}
                className="pill"
                href={{ pathname: '/sizes/[label]', params: { label: size.label } }}
              >
                {size.label}
                <span className="muted">
                  {t('sizes.productCount', { count: size.productCount })}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {otherEquivalents.length > 0 && (
        <section className="section">
          <h2>{t('size.equivalents')}</h2>
          <div className="pill-row">
            {otherEquivalents.map((equivalent) => (
              <Link
                key={equivalent.label}
                className="pill"
                href={{ pathname: '/sizes/[label]', params: { label: equivalent.label } }}
              >
                {equivalent.label}
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
