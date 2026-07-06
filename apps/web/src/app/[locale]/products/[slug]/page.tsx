import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { type Locale } from '@ffc/i18n';
import { Breadcrumbs, type Crumb } from '@/components/Breadcrumbs';
import { JsonLd } from '@/components/JsonLd';
import { ProductImage } from '@/components/ProductImage';
import { Link } from '@/i18n/navigation';
import { getProduct, listProducts, type ProductDetail } from '@/lib/api';
import { formatCents, formatDimensions, formatList } from '@/lib/format';
import { productImageUrl } from '@/lib/images';
import { productJsonLd } from '@/lib/jsonld';
import { pageMetadata } from '@/lib/seo';
import { absoluteUrl, type LocalizedHref } from '@/lib/site';

export const revalidate = 300;
// Slugs hors pré-rendu : générés à la demande puis mis en cache (ISR).
export const dynamicParams = true;

/**
 * Pré-rend la première page de produits de chaque locale au build; le reste
 * du catalogue se matérialise à la demande. API éteinte ⇒ liste vide, le
 * build n'échoue JAMAIS pour une raison réseau.
 */
export async function generateStaticParams({
  params,
}: {
  params: { locale: Locale };
}): Promise<Array<{ slug: string }>> {
  const list = await listProducts(params.locale, { limit: 24 });
  if (!list || list === 'not-found') return [];
  return list.items.map((item) => ({ slug: item.slug }));
}

/** Hrefs par locale de la fiche (slugs localisés de l'API) — hreflang. */
function productHrefs(product: ProductDetail): Partial<Record<Locale, LocalizedHref>> {
  return {
    fr: product.slugs.fr
      ? { pathname: '/products/[slug]', params: { slug: product.slugs.fr } }
      : undefined,
    en: product.slugs.en
      ? { pathname: '/products/[slug]', params: { slug: product.slugs.en } }
      : undefined,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const product = await getProduct(decodeURIComponent(slug), locale);
  if (!product || product === 'not-found') return {};

  const image = productImageUrl(product.images[0]);
  return pageMetadata({
    locale,
    hrefs: productHrefs(product),
    title: product.metaTitle ?? product.name,
    description: product.metaDescription ?? product.shortDescription ?? undefined,
    images: image ? [image] : undefined,
  });
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const product = await getProduct(decodeURIComponent(slug), locale);
  if (product === 'not-found') notFound();
  if (!product) {
    // API injoignable : erreur franche (pas de 404 mensonger, pas de cache
    // d'une coquille vide) — error.tsx affiche l'état dégradé.
    throw new Error('Catalogue indisponible');
  }

  const t = await getTranslations({ locale, namespace: 'web' });

  const crumbs: Crumb[] = [
    { name: t('breadcrumb.home'), href: '/' },
    ...(product.category
      ? [
          {
            name: product.category.name,
            href: {
              pathname: '/categories/[slug]',
              params: { slug: product.category.slug },
            } as LocalizedHref,
          },
        ]
      : []),
    { name: product.name },
  ];

  const currentHref = productHrefs(product)[locale];
  const url = currentHref ? absoluteUrl(locale, currentHref) : '';
  const imageUrls = product.images
    .map((image) => productImageUrl(image))
    .filter((u): u is string => u !== null);

  const mervValues = [
    ...new Set(
      product.variants.map((v) => v.merv).filter((m): m is number => typeof m === 'number'),
    ),
  ];
  const firstVariant = product.variants[0];
  const equipment = product.equipmentKinds.map((kind) => t(`product.equipmentKind.${kind}`));

  return (
    <main className="main container">
      <JsonLd data={productJsonLd({ product, url, locale, imageUrls })} />
      <Breadcrumbs locale={locale} items={crumbs} />

      <div className="product-layout">
        <div className="product-media">
          <ProductImage
            image={product.images[0]}
            name={product.name}
            sizeLabel={firstVariant?.nominalLabel}
            placeholderAlt={t('a11y.productImagePlaceholder', { name: product.name })}
            priority
          />
        </div>

        <div className="product-head">
          <p className="muted small">{product.brand.name}</p>
          <h1>{product.name}</h1>

          {product.reviews.count > 0 && (
            <p className="small">
              <span className="stars" aria-hidden="true">
                {'★'.repeat(Math.round(product.reviews.average))}
                {'☆'.repeat(5 - Math.round(product.reviews.average))}
              </span>{' '}
              <span className="muted">
                {t('product.ratingOutOf', { average: product.reviews.average })} ·{' '}
                {t('product.reviews', { count: product.reviews.count })}
              </span>
            </p>
          )}

          <div className="product-meta">
            {mervValues.map((merv) => (
              <span key={merv} className="badge badge-merv">
                {t('product.merv', { merv })}
              </span>
            ))}
            {firstVariant && <span className="badge badge-merv">{firstVariant.nominalLabel}</span>}
          </div>

          {product.shortDescription && <p>{product.shortDescription}</p>}
          {equipment.length > 0 && (
            <p className="muted small">
              {t('product.equipment', { kinds: formatList(equipment, locale) })}
            </p>
          )}

          <h2>{t('product.variantsTitle')}</h2>
          <table className="variant-table">
            <thead>
              <tr>
                <th>{t('product.packSize')}</th>
                <th>{t('product.price')}</th>
                <th>{t('product.unitPrice')}</th>
                <th>{t('product.availability')}</th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant) => (
                <tr key={variant.id}>
                  <td>{t('product.packOf', { count: variant.packSize })}</td>
                  <td className="price">
                    {formatCents(variant.priceCents, variant.currency, locale)}
                  </td>
                  <td className="muted">
                    {variant.packSize > 1
                      ? t('product.perFilter', {
                          price: formatCents(
                            Math.round(variant.priceCents / variant.packSize),
                            variant.currency,
                            locale,
                          ),
                        })
                      : '—'}
                  </td>
                  <td>
                    {variant.inStock ? (
                      <span className="badge badge-ok">{t('product.inStock')}</span>
                    ) : (
                      <span className="badge badge-out">{t('product.outOfStock')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="notice">{t('product.checkoutSoon')}</p>

          {firstVariant && (
            <div className="info-box">
              <strong>{t('product.nominalSize')}</strong> : {firstVariant.nominalLabel} ·{' '}
              <strong>{t('product.actualSize')}</strong> :{' '}
              {formatDimensions(
                {
                  width: firstVariant.actualWidthIn,
                  height: firstVariant.actualHeightIn,
                  depth: firstVariant.actualDepthIn,
                },
                locale,
              )}
            </div>
          )}
        </div>
      </div>

      {product.description && (
        <section className="section" style={{ maxWidth: '46rem' }}>
          <h2>{t('product.descriptionTitle')}</h2>
          <p>{product.description}</p>
        </section>
      )}

      {product.related.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t('product.related')}</h2>
          </div>
          <div className="pill-row">
            {product.related.map((related) => (
              <Link
                key={related.id}
                className="pill"
                href={{ pathname: '/products/[slug]', params: { slug: related.slug } }}
              >
                {related.name}
                <span className="muted">
                  {t('product.from', {
                    price: formatCents(related.priceFromCents, related.currency, locale),
                  })}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
