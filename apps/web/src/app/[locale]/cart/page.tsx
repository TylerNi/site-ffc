import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { CartView, type CartViewLabels } from '@/components/cart/CartView';
import { localizedPath } from '@/lib/site';

export const dynamic = 'force-static';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.cart' });
  // Page personnelle : jamais indexée.
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function CartPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.cart' });

  const labels: CartViewLabels = {
    title: t('title'),
    empty: t('empty'),
    browse: t('browse'),
    product: t('product'),
    price: t('price'),
    quantity: t('quantity'),
    total: t('total'),
    remove: t('remove'),
    decrease: t('decrease'),
    increase: t('increase'),
    subtotal: t('subtotal'),
    taxesAtCheckout: t('taxesAtCheckout'),
    checkout: t('checkout'),
    continueShopping: t('continueShopping'),
    loading: t('loading'),
    loadError: t('loadError'),
    retry: t('retry'),
    updateError: t('updateError'),
    removedUnavailable: t('removedUnavailable', { name: '{name}' }),
    removedOutOfStock: t('removedOutOfStock', { name: '{name}' }),
    adjusted: t('adjusted', { name: '{name}', from: '{from}', to: '{to}' }),
    priceChanged: t('priceChanged', { name: '{name}', from: '{from}', to: '{to}' }),
    onlyLeft: t('onlyLeft', { count: '{count}' }),
    merv: t('merv', { merv: '{merv}' }),
    packSingle: t('packSingle'),
    packBox: t('packBox', { count: '{count}' }),
  };

  return (
    <main className="main container cart-page">
      <h1>{labels.title}</h1>
      <CartView
        locale={locale}
        labels={labels}
        checkoutPath={localizedPath(locale, '/checkout')}
        browsePath={localizedPath(locale, '/')}
        productBasePath={localizedPath(locale, {
          pathname: '/products/[slug]',
          params: { slug: '_' },
        }).replace(/\/_$/, '')}
      />
    </main>
  );
}
