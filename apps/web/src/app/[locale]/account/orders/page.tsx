import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { buildAccountLabels } from '@/components/account/account-labels';
import { MesCommandes } from '@/components/account/MesCommandes';
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
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

export default async function MyOrdersPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.account' });
  const labels = buildAccountLabels(t);

  return (
    <main className="main container account-page">
      <h1>{labels.listTitle}</h1>
      <MesCommandes
        locale={locale}
        labels={labels}
        ordersPath={localizedPath(locale, '/account/orders')}
        browsePath={localizedPath(locale, '/')}
        shipmentsPath={localizedPath(locale, '/account/shipments')}
        shipmentsLabel={t('shipments.title')}
      />
    </main>
  );
}
