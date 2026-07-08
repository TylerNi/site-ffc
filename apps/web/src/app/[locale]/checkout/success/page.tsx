import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { SuccessView, type SuccessLabels } from '@/components/checkout/SuccessView';
import { localizedPath } from '@/lib/site';

export const dynamic = 'force-static';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.success' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function CheckoutSuccessPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.success' });
  const tc = await getTranslations({ locale, namespace: 'web.checkout' });

  const labels: SuccessLabels = {
    checking: t('checking'),
    paidTitle: t('paidTitle'),
    paidIntro: t('paidIntro', { number: '{number}', email: '{email}' }),
    processingTitle: t('processingTitle'),
    processingIntro: t('processingIntro'),
    failedTitle: t('failedTitle'),
    failedIntro: t('failedIntro'),
    failedRetry: t('failedRetry'),
    cancelledStockTitle: t('cancelledStockTitle'),
    cancelledStockIntro: t('cancelledStockIntro', { number: '{number}' }),
    invalidTitle: t('invalidTitle'),
    invalidIntro: t('invalidIntro'),
    summary: t('summary'),
    shippedTo: t('shippedTo'),
    backToShop: t('backToShop'),
    goToCheckout: t('goToCheckout'),
    subtotal: (await getTranslations({ locale, namespace: 'web.cart' }))('subtotal'),
    shipping: tc('shipping'),
    freeShipping: tc('freeShipping'),
    discount: tc('discount'),
    taxGst: tc('taxGst'),
    taxQst: tc('taxQst'),
    taxHst: tc('taxHst'),
    taxPst: tc('taxPst'),
    total: tc('total'),
  };

  return (
    <main className="main container success-page">
      <SuccessView
        locale={locale}
        labels={labels}
        homePath={localizedPath(locale, '/')}
        checkoutPath={localizedPath(locale, '/checkout')}
      />
    </main>
  );
}
