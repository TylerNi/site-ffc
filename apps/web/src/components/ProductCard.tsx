import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Link } from '@/i18n/navigation';
import { type ProductListItem } from '@/lib/api';
import { formatCents } from '@/lib/format';
import { ProductImage } from './ProductImage';

/** Carte produit des grilles (accueil, catégories, tailles, recherche). */
export async function ProductCard({
  product,
  locale,
  priority,
}: {
  product: ProductListItem;
  locale: Locale;
  priority?: boolean;
}) {
  const t = await getTranslations({ locale, namespace: 'web' });

  return (
    <article className="card">
      <div className="card-media">
        <ProductImage
          image={product.image}
          name={product.name}
          sizeLabel={product.nominalLabels[0]}
          placeholderAlt={t('a11y.productImagePlaceholder', { name: product.name })}
          priority={priority}
        />
      </div>
      <div className="card-body">
        <span className="card-brand">{product.brand.name}</span>
        <h3 className="card-name">
          <Link href={{ pathname: '/products/[slug]', params: { slug: product.slug } }}>
            {product.name}
          </Link>
        </h3>
        <div className="card-badges">
          {product.mervValues.map((merv) => (
            <span key={merv} className="badge badge-merv">
              {t('product.merv', { merv })}
            </span>
          ))}
          {product.inStock ? (
            <span className="badge badge-ok">{t('product.inStock')}</span>
          ) : (
            <span className="badge badge-out">{t('product.outOfStock')}</span>
          )}
        </div>
        <p className="card-price">
          {product.priceFromCents === product.priceToCents
            ? formatCents(product.priceFromCents, product.currency, locale)
            : t('product.from', {
                price: formatCents(product.priceFromCents, product.currency, locale),
              })}
        </p>
      </div>
    </article>
  );
}

/** Grille de cartes; `priorityCount` premières images en chargement immédiat. */
export function ProductGrid({
  products,
  locale,
  priorityCount = 0,
}: {
  products: ProductListItem[];
  locale: Locale;
  priorityCount?: number;
}) {
  return (
    <div className="grid">
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          locale={locale}
          priority={index < priorityCount}
        />
      ))}
    </div>
  );
}
