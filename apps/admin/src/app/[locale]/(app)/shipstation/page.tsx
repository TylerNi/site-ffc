'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import {
  type ShipstationSync,
  type ShipstationSyncPage,
  type ShipstationSyncStatus,
} from '@/lib/types';

/** Statuts consultables (la file d'échec d'abord — c'est elle qui bloque des colis). */
const STATUSES: ShipstationSyncStatus[] = [
  'SYNC_FAILED',
  'PENDING',
  'SYNCED',
  'CANCELLED',
  'SKIPPED',
];

const TONES: Record<ShipstationSyncStatus, 'ok' | 'warn' | 'muted' | 'neutral'> = {
  SYNC_FAILED: 'warn',
  PENDING: 'neutral',
  SYNCED: 'ok',
  CANCELLED: 'muted',
  SKIPPED: 'muted',
};

/**
 * Vue de resynchronisation ShipStation (tâche 13) — volontairement minimale :
 * la file d'échec, la cause de chaque échec, et le bouton « repousser ».
 * L'écran d'exploitation complet (recherche, détail de commande) arrive à la
 * tâche 22.
 */
export default function ShipstationPage() {
  const t = useTranslations('admin.shipstation');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const { request, can } = useAdminAuth();

  const [status, setStatus] = useState<ShipstationSyncStatus>('SYNC_FAILED');
  const [page, setPage] = useState<ShipstationSyncPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(
    async (next: ShipstationSyncStatus) => {
      setLoading(true);
      setError(null);
      try {
        setPage(await request<ShipstationSyncPage>(`/admin/shipstation?status=${next}&limit=50`));
      } catch (err) {
        setError(err instanceof AdminApiError ? err.message : tc('error'));
      } finally {
        setLoading(false);
      }
    },
    [request, tc],
  );

  useEffect(() => {
    void load(status);
  }, [load, status]);

  async function retry(orderId: string): Promise<void> {
    setRetrying(orderId);
    setError(null);
    try {
      await request<ShipstationSync>(`/admin/shipstation/${orderId}/retry`, { method: 'POST' });
      await load(status);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : tc('error'));
    } finally {
      setRetrying(null);
    }
  }

  const dateFmt = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const money = (cents: number, currency: string): string =>
    new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      style: 'currency',
      currency,
    }).format(cents / 100);

  const canRetry = can('shipments.write');

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('title')}</h1>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>
      </header>

      {page && !page.configured ? <Alert kind="info">{t('notConfigured')}</Alert> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="chip-row">
        {STATUSES.map((value) => (
          <Button
            key={value}
            variant={value === status ? 'primary' : 'ghost'}
            onClick={() => setStatus(value)}
          >
            {t(`status.${value}`)}
            {page ? ` (${page.counts[value]})` : ''}
          </Button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('colOrder')}</th>
              <th>{t('colOperation')}</th>
              <th>{t('colAttempts')}</th>
              <th>{t('colCause')}</th>
              <th>{t('colUpdated')}</th>
              {canRetry ? <th className="col-actions">{tc('none')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {page?.items.map((item) => (
              <tr key={item.orderId}>
                <td className="cell-nowrap">
                  <strong>{item.orderNumber}</strong>
                  <br />
                  <span className="muted">
                    {money(item.totalCents, item.currency)} · {item.orderStatus}
                  </span>
                </td>
                <td>
                  <Badge tone={TONES[item.status]}>{t(`operation.${item.operation}`)}</Badge>
                </td>
                <td>{item.attempts}</td>
                <td>{item.lastError ?? <span className="muted">{tc('none')}</span>}</td>
                <td className="cell-nowrap">{dateFmt.format(new Date(item.updatedAt))}</td>
                {canRetry ? (
                  <td className="col-actions">
                    <Button
                      variant="primary"
                      loading={retrying === item.orderId}
                      onClick={() => void retry(item.orderId)}
                    >
                      {t('retry')}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {loading ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : page && page.items.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : null}

      <p className="page-hint">{t('hint')}</p>
    </div>
  );
}
