import { getTranslations } from 'next-intl/server';
import { MERV_RATINGS } from '@ffc/core';
import { type Locale } from '@ffc/i18n';
import { type ListingFilters } from '@/lib/api';

/** Profondeurs nominales offertes (pouces) — alignées sur le catalogue. */
const DEPTHS = [1, 4, 5] as const;

/**
 * Filtres de liste en formulaire GET pur : crawlable, fonctionne sans
 * JavaScript, l'URL résultante est partageable. `hidden` reporte les
 * paramètres hors formulaire (ex. `q` sur la page de recherche).
 */
export async function FiltersForm({
  locale,
  action,
  filters,
  hidden = {},
  showDimension = true,
}: {
  locale: Locale;
  action: string;
  filters: ListingFilters;
  hidden?: Record<string, string>;
  showDimension?: boolean;
}) {
  const t = await getTranslations({ locale, namespace: 'web.listing' });

  return (
    <form className="filters" action={action} method="get">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {showDimension && (
        <label className="field">
          <span>{t('dimension')}</span>
          <input
            type="text"
            name="dimension"
            defaultValue={filters.dimension ?? ''}
            placeholder={t('dimensionPlaceholder')}
          />
        </label>
      )}

      <label className="field">
        <span>{t('merv')}</span>
        <select name="merv" defaultValue={filters.merv ?? ''}>
          <option value="">{t('any')}</option>
          {MERV_RATINGS.map((rating) => (
            <option key={rating.value} value={rating.value}>
              MERV {rating.value}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>{t('depth')}</span>
        <select name="depth" defaultValue={filters.depth ?? ''}>
          <option value="">{t('any')}</option>
          {DEPTHS.map((depth) => (
            <option key={depth} value={depth}>
              {t('depthValue', { depth })}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>{t('sort')}</span>
        <select name="sort" defaultValue={filters.sort ?? 'relevance'}>
          <option value="relevance">{t('sortRelevance')}</option>
          <option value="price">{t('sortPrice')}</option>
          <option value="popularity">{t('sortPopularity')}</option>
        </select>
      </label>

      <label className="field field-check">
        <input type="checkbox" name="inStock" value="true" defaultChecked={filters.inStock} />
        <span>{t('inStockOnly')}</span>
      </label>

      <button type="submit" className="btn">
        {t('apply')}
      </button>
      <a className="btn btn-ghost" href={action}>
        {t('reset')}
      </a>
    </form>
  );
}
