import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Link } from '@/i18n/navigation';
import { getCategories, getSizeIndex } from '@/lib/api';

/**
 * Pied de page avec maillage interne SEO : tailles populaires et catégories.
 * Les données viennent du cache de fetch — si l'API est injoignable, le
 * pied de page se réduit à la ligne légale.
 */
export async function Footer({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web' });
  const [categories, sizeIndex] = await Promise.all([getCategories(locale), getSizeIndex()]);

  const topSizes =
    sizeIndex && sizeIndex !== 'not-found'
      ? [...sizeIndex.sizes].sort((a, b) => b.productCount - a.productCount).slice(0, 8)
      : [];
  const rootCategories =
    categories && categories !== 'not-found'
      ? categories.categories.flatMap((root) => [root, ...root.children]).slice(0, 8)
      : [];

  return (
    <footer className="site-footer">
      <div className="container">
        {(topSizes.length > 0 || rootCategories.length > 0) && (
          <div className="footer-cols">
            <div>
              <h3>{t('meta.siteName')}</h3>
              <p className="muted">{t('footer.tagline')}</p>
            </div>
            {topSizes.length > 0 && (
              <div>
                <h3>{t('footer.sizes')}</h3>
                <ul>
                  {topSizes.map((size) => (
                    <li key={size.label}>
                      <Link href={{ pathname: '/sizes/[label]', params: { label: size.label } }}>
                        {size.label}
                      </Link>
                    </li>
                  ))}
                  <li>
                    <Link href="/sizes">{t('footer.allSizes')}</Link>
                  </li>
                </ul>
              </div>
            )}
            {rootCategories.length > 0 && (
              <div>
                <h3>{t('footer.categories')}</h3>
                <ul>
                  {rootCategories.map((category) => (
                    <li key={category.slug}>
                      <Link
                        href={{ pathname: '/categories/[slug]', params: { slug: category.slug } }}
                      >
                        {category.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <p className="footer-legal">{t('footer.legal', { year: new Date().getFullYear() })}</p>
      </div>
    </footer>
  );
}
