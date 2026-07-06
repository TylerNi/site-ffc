import { getTranslations } from 'next-intl/server';
import { type Locale } from '@ffc/i18n';

/**
 * Pièces partagées des pages de liste : compteur de résultats, pagination
 * par curseur (liens crawlables) et état « catalogue indisponible ».
 */

export async function ResultCount({
  locale,
  count,
  hasMore,
}: {
  locale: Locale;
  count: number;
  hasMore: boolean;
}) {
  const t = await getTranslations({ locale, namespace: 'web.listing' });
  return <p className="result-count">{t('resultCount', { count, hasMore: String(hasMore) })}</p>;
}

/** Pagination avant par curseur; « revenir au début » quand on est paginé. */
export async function CursorPager({
  locale,
  basePath,
  query,
  nextCursor,
  isPaginated,
}: {
  locale: Locale;
  basePath: string;
  /** Paramètres de filtre courants à conserver dans les liens. */
  query: Record<string, string>;
  nextCursor: string | null | undefined;
  isPaginated: boolean;
}) {
  const t = await getTranslations({ locale, namespace: 'web' });
  if (!nextCursor && !isPaginated) return null;

  const withParams = (extra: Record<string, string>) => {
    const params = new URLSearchParams({ ...query, ...extra });
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <nav className="pager" aria-label={t('a11y.pagination')}>
      {isPaginated && (
        <a className="btn btn-ghost" href={withParams({})}>
          {t('listing.backToFirst')}
        </a>
      )}
      {nextCursor && (
        <a className="btn" href={withParams({ cursor: nextCursor })} rel="next">
          {t('listing.nextPage')}
        </a>
      )}
    </nav>
  );
}

/** État dégradé quand l'API catalogue est injoignable (se régénère vite). */
export async function CatalogUnavailable({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web.listing' });
  return (
    <div className="empty-state">
      <h2>{t('unavailableTitle')}</h2>
      <p>{t('unavailableText')}</p>
    </div>
  );
}

/** Aucun résultat pour ces filtres. */
export async function NoResults({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'web.listing' });
  return (
    <div className="empty-state">
      <p>{t('noResults')}</p>
      <p className="small">{t('noResultsTip')}</p>
    </div>
  );
}
