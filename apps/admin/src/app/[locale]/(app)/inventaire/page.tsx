'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button, Field, Input, Spinner } from '@/components/ui';
import { AdjustModal, HistoryModal, ThresholdModal } from '@/components/StockModals';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type InventoryItem, type InventoryPage } from '@/lib/types';

type ModalState =
  | { kind: 'adjust'; item: InventoryItem }
  | { kind: 'threshold'; item: InventoryItem }
  | { kind: 'history'; item: InventoryItem }
  | null;

export default function InventoryPageScreen() {
  const t = useTranslations('admin.inventory');
  const ts = useTranslations('admin.stock');
  const tc = useTranslations('admin.common');
  const { request, can } = useAdminAuth();
  const canWrite = can('inventory.write');

  const [q, setQ] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [page, setPage] = useState<InventoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(
    async (params: { q: string; lowStockOnly: boolean }) => {
      setError(null);
      try {
        const query = new URLSearchParams({ pageSize: '50' });
        if (params.q.trim()) query.set('q', params.q.trim());
        if (params.lowStockOnly) query.set('lowStockOnly', 'true');
        setPage(await request<InventoryPage>(`/admin/inventory?${query.toString()}`));
      } catch (err) {
        setError(err instanceof AdminApiError ? err.message : tc('error'));
        setPage({ items: [], total: 0, page: 1, pageSize: 50 });
      }
    },
    [request, tc],
  );

  useEffect(() => {
    void load({ q: '', lowStockOnly: false });
  }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void load({ q, lowStockOnly });
  }

  function resetFilters(): void {
    setQ('');
    setLowStockOnly(false);
    void load({ q: '', lowStockOnly: false });
  }

  async function refresh(): Promise<void> {
    await load({ q, lowStockOnly });
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('title')}</h1>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>
      </header>

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      <form className="filters" onSubmit={applyFilters}>
        <Field label={t('searchPlaceholder')}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />
          <span>{t('lowStockOnly')}</span>
        </label>
        <div className="filters-actions">
          <Button type="submit" variant="primary">
            {tc('search')}
          </Button>
          <Button type="button" variant="ghost" onClick={resetFilters}>
            {tc('cancel')}
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
                <th>{t('colSku')}</th>
                <th>{t('colProduct')}</th>
                <th>{t('colSize')}</th>
                <th>{t('colOnHand')}</th>
                <th>{t('colReserved')}</th>
                <th>{t('colAvailable')}</th>
                <th>{t('colThreshold')}</th>
                <th className="col-actions">{tc('none')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.variantId}>
                  <td className="cell-mono">{item.sku}</td>
                  <td>{item.productName}</td>
                  <td>{item.nominalLabel}</td>
                  <td>
                    {item.isLowStock ? (
                      <Badge tone="warn">{item.quantityOnHand}</Badge>
                    ) : (
                      item.quantityOnHand
                    )}
                  </td>
                  <td>{item.quantityReserved}</td>
                  <td>{item.availableQuantity}</td>
                  <td>{item.lowStockThreshold ?? t('noThreshold')}</td>
                  <td className="col-actions">
                    <button
                      className="link-btn"
                      onClick={() => setModal({ kind: 'history', item })}
                    >
                      {t('history')}
                    </button>
                    {canWrite ? (
                      <>
                        <button
                          className="link-btn"
                          onClick={() => setModal({ kind: 'threshold', item })}
                        >
                          {t('setThreshold')}
                        </button>
                        <button
                          className="link-btn"
                          onClick={() => setModal({ kind: 'adjust', item })}
                        >
                          {t('adjust')}
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === 'adjust' ? (
        <AdjustModal
          item={modal.item}
          onClose={() => setModal(null)}
          onSubmit={async (body) => {
            await request(`/admin/inventory/${modal.item.variantId}/adjustments`, {
              method: 'POST',
              body,
            });
            setNotice(ts('adjusted'));
            setModal(null);
            await refresh();
          }}
        />
      ) : null}

      {modal?.kind === 'threshold' ? (
        <ThresholdModal
          item={modal.item}
          onClose={() => setModal(null)}
          onSubmit={async (lowStockThreshold) => {
            await request(`/admin/inventory/${modal.item.variantId}/threshold`, {
              method: 'PATCH',
              body: { lowStockThreshold },
            });
            setNotice(ts('thresholdSaved'));
            setModal(null);
            await refresh();
          }}
        />
      ) : null}

      {modal?.kind === 'history' ? (
        <HistoryModal item={modal.item} onClose={() => setModal(null)} />
      ) : null}
    </div>
  );
}
