'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AdminApiError } from '@/lib/api';
import { useAdminAuth } from '@/lib/auth-context';
import { type InventoryMovement, type InventoryMovementPage } from '@/lib/types';
import { Alert, Button, Field, Input, Modal, Select, Spinner } from './ui';

/**
 * Modales d'inventaire (tâche 10) — partagées entre l'écran « Inventaire »
 * et la fiche produit (section variantes, « fixer prix et stock »).
 */

export function AdjustModal({
  item,
  onClose,
  onSubmit,
}: {
  item: { variantId: string; sku: string };
  onClose: () => void;
  onSubmit: (body: { type: string; quantity: number; reason: string }) => Promise<void>;
}) {
  const t = useTranslations('admin.stock');
  const tc = useTranslations('admin.common');
  const [type, setType] = useState<'RECEIPT' | 'RETURN' | 'ADJUSTMENT'>('RECEIPT');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = Number.parseInt(quantity, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError(t('quantityHint'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ type, quantity: parsed, reason: reason.trim() });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={t('adjustTitle', { sku: item.sku })} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('type')}>
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="RECEIPT">{t('typeReceipt')}</option>
            <option value="RETURN">{t('typeReturn')}</option>
            <option value="ADJUSTMENT">{t('typeAdjustment')}</option>
          </Select>
        </Field>
        <Field label={t('quantity')} hint={t('quantityHint')}>
          <Input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
          />
        </Field>
        <Field label={t('reason')}>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
          />
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ThresholdModal({
  item,
  onClose,
  onSubmit,
}: {
  item: { variantId: string; sku: string; lowStockThreshold?: number | null };
  onClose: () => void;
  onSubmit: (lowStockThreshold: number | null) => Promise<void>;
}) {
  const t = useTranslations('admin.stock');
  const tc = useTranslations('admin.common');
  const [value, setValue] = useState(item.lowStockThreshold?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const trimmed = value.trim();
      await onSubmit(trimmed === '' ? null : Number.parseInt(trimmed, 10));
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={t('thresholdTitle', { sku: item.sku })} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label={t('thresholdLabel')} hint={t('thresholdHint')}>
          <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function HistoryModal({
  item,
  onClose,
}: {
  item: { variantId: string; sku: string };
  onClose: () => void;
}) {
  const t = useTranslations('admin.stock');
  const locale = useLocale();
  const { request } = useAdminAuth();
  const [items, setItems] = useState<InventoryMovement[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const dateFmt = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const loadPage = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const query = after ? `?cursor=${after}` : '';
        const page = await request<InventoryMovementPage>(
          `/admin/inventory/${item.variantId}/movements${query}`,
        );
        setItems((prev) => (after ? [...(prev ?? []), ...page.items] : page.items));
        setCursor(page.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [request, item.variantId],
  );

  useEffect(() => {
    void loadPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal open title={t('historyTitle', { sku: item.sku })} onClose={onClose}>
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="page-empty">{t('historyEmpty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('colDate')}</th>
                <th>{t('colType')}</th>
                <th>{t('colDelta')}</th>
                <th>{t('colReason')}</th>
                <th>{t('colActor')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((movement) => (
                <tr key={movement.id}>
                  <td className="cell-nowrap">{dateFmt.format(new Date(movement.createdAt))}</td>
                  <td>{movement.type}</td>
                  <td>{movement.quantity > 0 ? `+${movement.quantity}` : movement.quantity}</td>
                  <td>{movement.reason ?? '—'}</td>
                  <td className="muted">{movement.createdByEmail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor ? (
        <div className="load-more">
          <Button loading={loading} onClick={() => void loadPage(cursor)}>
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
