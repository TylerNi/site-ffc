'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type AuditLogEntry, type AuditLogPage } from '@/lib/types';

interface Filters {
  actorId: string;
  entityType: string;
  action: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { actorId: '', entityType: '', action: '', from: '', to: '' };

export default function AuditPage() {
  const t = useTranslations('admin.audit');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const { request } = useAdminAuth();

  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = useCallback(
    (next: string | null): string => {
      const params = new URLSearchParams();
      if (filters.actorId.trim()) params.set('actorId', filters.actorId.trim());
      if (filters.entityType.trim()) params.set('entityType', filters.entityType.trim());
      if (filters.action.trim()) params.set('action', filters.action.trim());
      if (filters.from) params.set('from', new Date(filters.from).toISOString());
      if (filters.to) params.set('to', new Date(filters.to).toISOString());
      if (next) params.set('cursor', next);
      params.set('limit', '25');
      return params.toString();
    },
    [filters],
  );

  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await request<AuditLogPage>(`/admin/audit-logs?${buildQuery(next)}`);
        setItems((prev) => (next ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof AdminApiError ? err.message : tc('error'));
      } finally {
        setLoading(false);
      }
    },
    [buildQuery, request, tc],
  );

  // Chargement initial seulement; les filtres se rejouent via « Filtrer ».
  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void load(null);
  }

  function reset(): void {
    setFilters(EMPTY);
  }

  const dateFmt = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t('title')}</h1>
          <p className="page-subtitle">{t('readOnly')}</p>
        </div>
      </header>

      <form className="filters" onSubmit={applyFilters}>
        <Field label={t('filterAction')}>
          <Input
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
            placeholder="admin.users"
          />
        </Field>
        <Field label={t('filterEntityType')}>
          <Input
            value={filters.entityType}
            onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value }))}
            placeholder="user"
          />
        </Field>
        <Field label={t('filterActor')}>
          <Input
            value={filters.actorId}
            onChange={(e) => setFilters((f) => ({ ...f, actorId: e.target.value }))}
          />
        </Field>
        <Field label={t('filterFrom')}>
          <Input
            type="datetime-local"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </Field>
        <Field label={t('filterTo')}>
          <Input
            type="datetime-local"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </Field>
        <div className="filters-actions">
          <Button type="submit" variant="primary">
            {t('apply')}
          </Button>
          <Button type="button" onClick={reset}>
            {t('reset')}
          </Button>
        </div>
      </form>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('colWhen')}</th>
              <th>{t('colActor')}</th>
              <th>{t('colAction')}</th>
              <th>{t('colEntity')}</th>
              <th>{t('colDetails')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className="cell-nowrap">{dateFmt.format(new Date(entry.createdAt))}</td>
                <td>{entry.actorEmail ?? <span className="muted">{entry.actorType}</span>}</td>
                <td className="cell-mono">{entry.action}</td>
                <td className="cell-mono">
                  {entry.entityType
                    ? `${entry.entityType}${entry.entityId ? `:${entry.entityId.slice(0, 8)}` : ''}`
                    : tc('none')}
                </td>
                <td>
                  <AuditDetails entry={entry} beforeLabel={t('before')} afterLabel={t('after')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {loading ? (
        <div className="page-loading">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="page-empty">{t('empty')}</p>
      ) : cursor ? (
        <div className="load-more">
          <Button onClick={() => void load(cursor)}>{t('loadMore')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function AuditDetails({
  entry,
  beforeLabel,
  afterLabel,
}: {
  entry: AuditLogEntry;
  beforeLabel: string;
  afterLabel: string;
}) {
  const hasDiff = entry.before != null || entry.after != null;
  if (!hasDiff && entry.metadata == null) return <span className="muted">—</span>;
  return (
    <details className="audit-details">
      <summary>{'{…}'}</summary>
      {entry.before != null ? (
        <div>
          <strong>{beforeLabel}</strong>
          <pre>{JSON.stringify(entry.before, null, 2)}</pre>
        </div>
      ) : null}
      {entry.after != null ? (
        <div>
          <strong>{afterLabel}</strong>
          <pre>{JSON.stringify(entry.after, null, 2)}</pre>
        </div>
      ) : null}
      {entry.metadata != null ? <pre>{JSON.stringify(entry.metadata, null, 2)}</pre> : null}
    </details>
  );
}
