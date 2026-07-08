import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { CheckoutFlow, type CheckoutLabels } from '@/components/checkout/CheckoutFlow';
import { localizedPath } from '@/lib/site';

export const dynamic = 'force-static';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.checkout' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function CheckoutPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.checkout' });
  const tc = await getTranslations({ locale, namespace: 'web.cart' });

  const labels: CheckoutLabels = {
    title: t('title'),
    contact: t('contact'),
    email: t('email'),
    emailHelp: t('emailHelp'),
    shippingAddress: t('shippingAddress'),
    firstName: t('firstName'),
    lastName: t('lastName'),
    company: t('company'),
    line1: t('line1'),
    line2: t('line2'),
    city: t('city'),
    country: t('country'),
    countryCA: t('countryCA'),
    countryUS: t('countryUS'),
    province: t('province'),
    state: t('state'),
    postalCode: t('postalCode'),
    zipCode: t('zipCode'),
    phone: t('phone'),
    invalidEmail: t('invalidEmail'),
    invalidPostalCode: t('invalidPostalCode'),
    invalidZip: t('invalidZip'),
    requiredField: t('requiredField'),
    coupon: t('coupon'),
    couponPlaceholder: t('couponPlaceholder'),
    note: t('note'),
    continueToPayment: t('continueToPayment'),
    preparing: t('preparing'),
    payment: t('payment'),
    editDetails: t('editDetails'),
    payButton: t('payButton', { amount: '{amount}' }),
    processing: t('processing'),
    paymentUnavailable: t('paymentUnavailable'),
    paymentNotConfigured: t('paymentNotConfigured'),
    summary: t('summary'),
    subtotal: tc('subtotal'),
    shipping: t('shipping'),
    freeShipping: t('freeShipping'),
    discount: t('discount'),
    taxGst: t('taxGst'),
    taxQst: t('taxQst'),
    taxHst: t('taxHst'),
    taxPst: t('taxPst'),
    total: t('total'),
    secureNotice: t('secureNotice'),
    cartChanged: t('cartChanged'),
    cartEmpty: t('cartEmpty'),
    backToCart: t('backToCart'),
    genericError: t('genericError'),
    couponErrors: {
      COUPON_NOT_FOUND: t('couponErrors.COUPON_NOT_FOUND'),
      COUPON_INACTIVE: t('couponErrors.COUPON_INACTIVE'),
      COUPON_NOT_STARTED: t('couponErrors.COUPON_NOT_STARTED'),
      COUPON_EXPIRED: t('couponErrors.COUPON_EXPIRED'),
      COUPON_EXHAUSTED: t('couponErrors.COUPON_EXHAUSTED'),
      COUPON_MIN_SUBTOTAL: t('couponErrors.COUPON_MIN_SUBTOTAL'),
      COUPON_ALREADY_USED: t('couponErrors.COUPON_ALREADY_USED'),
    },
  };

  return (
    <main className="main container checkout-page">
      <h1>{labels.title}</h1>
      <CheckoutFlow
        locale={locale}
        labels={labels}
        publishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
        cartPath={localizedPath(locale, '/cart')}
        successPath={localizedPath(locale, '/checkout/success')}
      />
    </main>
  );
}
