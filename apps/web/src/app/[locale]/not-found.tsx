import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/** 404 localisée — déclenchée par notFound() dans le segment [locale]. */
export default async function NotFoundPage() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'web.notFound' });

  return (
    <main className="main container">
      <div className="empty-state" style={{ paddingBlock: '4rem' }}>
        <h1>{t('title')}</h1>
        <p>{t('text')}</p>
        <p className="pill-row" style={{ justifyContent: 'center' }}>
          <Link className="btn" href="/">
            {t('backHome')}
          </Link>
          <Link className="btn btn-ghost" href="/sizes">
            {t('browseSizes')}
          </Link>
        </p>
      </div>
    </main>
  );
}
