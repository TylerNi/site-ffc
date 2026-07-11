'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Field, Input, Select, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AdminBrand, type ProductListPage, type ProductStatus } from '@/lib/types';

const STATUS_TONES: Record<ProductStatus, 'ok' | 'warn' | 'muted'> = {
  DRAFT: 'warn',
  ACTIVE: 'ok',
  ARCHIVED: 'muted',
};

interface Filters {
  q: string;
  status: ProductStatus | '';
  brandId: string;
  dimension: string;
  merv: string;
}

const EMPTY_FILTERS: Filters = { q: '', status: '', brandId: '', dimension: '', merv: '' };

export default function CatalogPage() {
  const t = useTranslations('admin.products');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const { request, can } = useAdminAuth();
  const canWrite = can('products.write');

  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState<ProductListPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void request<AdminBrand[]>('/admin/brands')
      .then(setBrands)
      .catch(() => undefined);
  }, [request]);

  const queryString = useCallback((applied: Filters, cursor?: string): string => {
    const params = new URLSearchParams({ limit: '24' });
    if (applied.q.trim()) params.set('q', applied.q.trim());
    if (applied.status) params.set('status', applied.status);
    if (applied.brandId) params.set('brandId', applied.brandId);
    if (applied.dimension.trim()) params.set('dimension', applied.dimension.trim());
    if (applied.merv.trim()) params.set('merv', applied.merv.trim());
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }, []);

  const load = useCallback(
    async (applied: Filters, cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await request<ProductListPage>(
          `/admin/products?${queryString(applied, cursor)}`,
        );
        setPage((prev) =>
          cursor && prev ? { ...result, items: [...prev.items, ...result.items] } : result,
        );
      } catch (err) {
        setError(err instanceof AdminApiError ? err.message : tc('error'));
      } finally {
        setLoading(false);
      }
    },
    [request, queryString, tc],
  );

  useEffect(() => {
    void load(EMPTY_FILTERS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void load(filters);
  }

  function resetFilters(): void {
    setFilters(EMPTY_FILTERS);
    void load(EMPTY_FILTERS);
  }

  const money = (cents: number | null): string =>
    cents === null
      ? '—'
      : new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
          style: 'currency',
          currency: 'CAD',
        }).format(cents / 100);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('title')}</h1>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>
        {canWrite ? (
          <div className="page-actions">
            <Link href="/catalogue/nouveau" className="btn btn-primary">
              {t('newProduct')}
            </Link>
          </div>
        ) : null}
      </header>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <form className="filters" onSubmit={applyFilters}>
        <Field label={t('searchPlaceholder')}>
          <Input
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </Field>
        <Field label={t('filterStatus')}>
          <Select
            value={filters.status}
            onChange={(e) =>
              setFilters({ ...filters, status: e.target.value as ProductStatus | '' })
            }
          >
            <option value="">{t('allStatuses')}</option>
            <option value="DRAFT">{t('statusDraft')}</option>
            <option value="ACTIVE">{t('statusActive')}</option>
            <option value="ARCHIVED">{t('statusArchived')}</option>
          </Select>
        </Field>
        <Field label={t('filterBrand')}>
          <Select
            value={filters.brandId}
            onChange={(e) => setFilters({ ...filters, brandId: e.target.value })}
          >
            <option value="">{t('allBrands')}</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('filterDimension')}>
          <Input
            value={filters.dimension}
            onChange={(e) => setFilters({ ...filters, dimension: e.target.value })}
            placeholder="16x25x1"
          />
        </Field>
        <Field label={t('filterMerv')}>
          <Input
            type="number"
            value={filters.merv}
            onChange={(e) => setFilters({ ...filters, merv: e.target.value })}
            min={1}
            max={20}
          />
        </Field>
        <div className="filters-actions">
          <Button type="submit" variant="primary">
            {t('apply')}
          </Button>
          <Button type="button" variant="ghost" onClick={resetFilters}>
            {t('reset')}
          </Button>
        </div>
      </form>

      {!page ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : page.items.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('colName')}</th>
                <th>{t('colBrand')}</th>
                <th>{t('colCategory')}</th>
                <th>{t('colStatus')}</th>
                <th>{t('colVariants')}</th>
                <th>{t('colPrice')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/catalogue/${item.id}`}>{item.name}</Link>
                    {item.translatedLocales.length < 2 ? (
                      <>
                        {' '}
                        <Badge tone="warn">{t('missingTranslation')}</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>{item.brand.name}</td>
                  <td>{item.category?.name ?? tc('none')}</td>
                  <td>
                    <Badge tone={STATUS_TONES[item.status]}>
                      {t(`status${capitalize(item.status)}`)}
                    </Badge>
                  </td>
                  <td>{item.variantCount}</td>
                  <td>{money(item.priceFromCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page?.hasMore ? (
        <div className="load-more">
          <Button
            loading={loading}
            onClick={() => void load(filters, page.nextCursor ?? undefined)}
          >
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function capitalize(status: ProductStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
