'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Spinner } from '@/components/ui';
import { useAdminAuth } from '@/lib/auth-context';
import { type DashboardSummary } from '@/lib/types';

export default function DashboardPage() {
  const t = useTranslations('admin.dashboard');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const { request } = useAdminAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setSummary(await request<DashboardSummary>('/admin/dashboard/summary'));
    } catch {
      setError(true);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (cents: number): string =>
    new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
      style: 'currency',
      currency: summary?.currency ?? 'CAD',
    }).format(cents / 100);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('title')}</h1>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>
      </header>

      {error ? (
        <Alert kind="error">{tc('error')}</Alert>
      ) : !summary ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : (
        <div className="tiles">
          <Tile label={t('salesToday')} value={money(summary.salesTodayCents)} />
          <Tile label={t('ordersToday')} value={summary.ordersTodayCount} />
          <Tile label={t('ordersToShip')} value={summary.ordersToShip} />
          <Tile label={t('pendingReviews')} value={summary.pendingReviews} />
          <Tile label={t('aiQueue')} value={summary.aiReviewQueue} />
          <Tile label={t('lowStock')} value={summary.lowStock} />
        </div>
      )}

      <p className="page-hint">{t('sectionsHint')}</p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}
