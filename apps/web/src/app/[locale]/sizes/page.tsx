import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { CatalogUnavailable } from '@/components/listing';
import { Link } from '@/i18n/navigation';
import { getSizeIndex } from '@/lib/api';
import { pageMetadata } from '@/lib/seo';

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.meta' });
  return pageMetadata({
    locale,
    hrefs: { fr: '/sizes', en: '/sizes' },
    title: t('sizesTitle'),
    description: t('sizesDescription'),
  });
}

export default async function SizesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web' });

  const index = await getSizeIndex();
  const sizes = index && index !== 'not-found' ? index.sizes : null;

  // Sections par profondeur (1 po, 4 po, 5 po…), tailles en ordre croissant.
  const byDepth = new Map<number, NonNullable<typeof sizes>>();
  for (const size of sizes ?? []) {
    const group = byDepth.get(size.depth) ?? [];
    group.push(size);
    byDepth.set(size.depth, group);
  }

  return (
    <main className="main container">
      <Breadcrumbs
        locale={locale}
        items={[{ name: t('breadcrumb.home'), href: '/' }, { name: t('breadcrumb.sizes') }]}
      />
      <h1>{t('sizes.title')}</h1>
      <p className="muted" style={{ maxWidth: '42rem' }}>
        {t('sizes.intro')}
      </p>

      {!sizes && <CatalogUnavailable locale={locale} />}

      <div className="size-sections">
        {[...byDepth.entries()]
          .sort(([a], [b]) => a - b)
          .map(([depth, group]) => (
            <section key={depth}>
              <h2>{t('sizes.depthSection', { depth })}</h2>
              <div className="pill-row">
                {group.map((size) => (
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
          ))}
      </div>
    </main>
  );
}
