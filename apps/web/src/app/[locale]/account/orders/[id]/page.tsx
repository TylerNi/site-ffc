import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';
import { buildAccountLabels } from '@/components/account/account-labels';
import { MesCommandes } from '@/components/account/MesCommandes';
import { localizedPath } from '@/lib/site';

// Shell client identique pour toute commande (le détail est chargé côté
// navigateur, par id) : rendu à la demande, sans génération statique par id.
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'web.account' });
  return { title: t('detailTitle'), robots: { index: false, follow: false } };
}

export default async function MyOrderDetailPage({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'web.account' });
  const labels = buildAccountLabels(t);

  return (
    <main className="main container account-page">
      <h1>{labels.detailTitle}</h1>
      <MesCommandes
        locale={locale}
        labels={labels}
        orderId={id}
        ordersPath={localizedPath(locale, '/account/orders')}
        browsePath={localizedPath(locale, '/')}
        shipmentsPath={localizedPath(locale, '/account/shipments')}
        shipmentsLabel={t('shipments.title')}
      />
    </main>
  );
}
