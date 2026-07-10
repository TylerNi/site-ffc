import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { MesColis } from '@/components/account/MesColis';
import { buildShipmentsLabels } from '@/components/account/shipments-labels';
import { localizedPath } from '@/lib/site';

// Espace personnel : rendu client (session dans le navigateur), jamais indexé.
export const dynamic = 'force-static';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.account' });
  return { title: t('shipments.metaTitle'), robots: { index: false, follow: false } };
}

export default async function MyShipmentsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.account' });
  const labels = buildShipmentsLabels(t);

  return (
    <main className="main container account-page">
      <h1>{labels.title}</h1>
      <MesColis
        locale={locale}
        labels={labels}
        ordersPath={localizedPath(locale, '/account/orders')}
        browsePath={localizedPath(locale, '/')}
      />
    </main>
  );
}
