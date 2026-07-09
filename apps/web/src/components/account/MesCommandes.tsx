'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { type Locale } from '@ffc/i18n';
import { formatCents } from '@/lib/format';
import { ApiError } from '@/lib/cart-client';
import {
  AUTH_CHANGED_EVENT,
  cancelMyOrder,
  downloadInvoice,
  getMyOrder,
  isSignedIn,
  listMyOrders,
  type MyOrderDetail,
  type MyOrderListItem,
  NotAuthenticatedError,
  type OrderStatus,
  signOutLocal,
} from '@/lib/account-client';
import { SignInForm, type SignInLabels } from './SignInForm';

export interface MesCommandesLabels {
  signin: SignInLabels;
  listTitle: string;
  detailTitle: string;
  empty: string;
  browse: string;
  order: string;
  date: string;
  status: string;
  total: string;
  view: string;
  back: string;
  items: string;
  quantity: string;
  invoice: string;
  downloadInvoice: string;
  invoicePending: string;
  cancel: string;
  cancelConfirm: string;
  cancelling: string;
  cancelled: string;
  refundNote: string;
  timeline: string;
  shippingAddress: string;
  subtotal: string;
  discount: string;
  shipping: string;
  free: string;
  gst: string;
  qst: string;
  hst: string;
  pst: string;
  paidWith: string;
  loading: string;
  loadError: string;
  retry: string;
  signOut: string;
  actorClient: string;
  actorAdmin: string;
  actorSystem: string;
}

interface Props {
  locale: Locale;
  labels: MesCommandesLabels;
  ordersPath: string;
  browsePath: string;
  /** Présent = vue détail ; absent = vue liste. */
  orderId?: string;
}

function fmtDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

const STATUS_TONE: Record<OrderStatus, string> = {
  PENDING: 'is-pending',
  PAID: 'is-paid',
  PROCESSING: 'is-processing',
  SHIPPED: 'is-shipped',
  DELIVERED: 'is-delivered',
  CANCELLED: 'is-cancelled',
  REFUNDED: 'is-refunded',
  PARTIALLY_REFUNDED: 'is-refunded',
};

function StatusBadge({ status, label }: { status: OrderStatus; label: string }) {
  return <span className={`order-badge ${STATUS_TONE[status]}`}>{label}</span>;
}

/** Espace « Mes commandes » : porte de connexion, puis liste ou détail. */
export function MesCommandes({ locale, labels, ordersPath, browsePath, orderId }: Props) {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(isSignedIn());
    const onChange = (): void => setAuthed(isSignedIn());
    window.addEventListener(AUTH_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onChange);
  }, []);

  if (authed === null) return <p className="account-muted">{labels.loading}</p>;
  if (!authed) {
    return <SignInForm labels={labels.signin} onSignedIn={() => setAuthed(true)} />;
  }

  return (
    <>
      <div className="account-toolbar">
        <button type="button" className="btn btn-ghost" onClick={() => signOutLocal()}>
          {labels.signOut}
        </button>
      </div>
      {orderId ? (
        <OrderDetailView
          locale={locale}
          labels={labels}
          orderId={orderId}
          ordersPath={ordersPath}
        />
      ) : (
        <OrdersListView
          locale={locale}
          labels={labels}
          ordersPath={ordersPath}
          browsePath={browsePath}
        />
      )}
    </>
  );
}

/* -------------------------------- Liste ---------------------------------- */

function OrdersListView({
  locale,
  labels,
  ordersPath,
  browsePath,
}: {
  locale: Locale;
  labels: MesCommandesLabels;
  ordersPath: string;
  browsePath: string;
}) {
  const [orders, setOrders] = useState<MyOrderListItem[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setOrders(null);
    listMyOrders()
      .then((page) => setOrders(page.items))
      .catch((err) => {
        if (err instanceof NotAuthenticatedError) signOutLocal();
        else setError(true);
      });
  }, []);

  useEffect(load, [load]);

  if (error) {
    return (
      <div className="account-error" role="alert">
        <p>{labels.loadError}</p>
        <button type="button" className="btn" onClick={load}>
          {labels.retry}
        </button>
      </div>
    );
  }
  if (orders === null) return <p className="account-muted">{labels.loading}</p>;
  if (orders.length === 0) {
    return (
      <p className="account-muted">
        {labels.empty} <Link href={browsePath}>{labels.browse}</Link>
      </p>
    );
  }

  return (
    <table className="orders-table">
      <thead>
        <tr>
          <th>{labels.order}</th>
          <th>{labels.date}</th>
          <th>{labels.status}</th>
          <th>{labels.total}</th>
          <th aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td data-label={labels.order}>{order.number}</td>
            <td data-label={labels.date}>{fmtDate(order.placedAt, locale)}</td>
            <td data-label={labels.status}>
              <StatusBadge status={order.status} label={order.statusLabel} />
            </td>
            <td data-label={labels.total}>
              {formatCents(order.totalCents, order.currency, locale)}
            </td>
            <td>
              <Link className="btn btn-ghost" href={`${ordersPath}/${order.id}`}>
                {labels.view}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* -------------------------------- Détail --------------------------------- */

function OrderDetailView({
  locale,
  labels,
  orderId,
  ordersPath,
}: {
  locale: Locale;
  labels: MesCommandesLabels;
  orderId: string;
  ordersPath: string;
}) {
  const [order, setOrder] = useState<MyOrderDetail | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    setOrder(null);
    getMyOrder(orderId)
      .then(setOrder)
      .catch((err) => {
        if (err instanceof NotAuthenticatedError) signOutLocal();
        else setError(true);
      });
  }, [orderId]);

  useEffect(load, [load]);

  const money = (cents: number): string => formatCents(cents, order?.currency ?? 'CAD', locale);
  const actorLabel = (actor: 'client' | 'admin' | 'system'): string =>
    actor === 'client'
      ? labels.actorClient
      : actor === 'admin'
        ? labels.actorAdmin
        : labels.actorSystem;

  async function onCancel(): Promise<void> {
    if (!window.confirm(labels.cancelConfirm)) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await cancelMyOrder(orderId);
      const refund = result.refundAmountCents
        ? ` ${labels.refundNote.replace('{amount}', money(result.refundAmountCents))}`
        : '';
      setNotice(labels.cancelled + refund);
      load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : labels.loadError);
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(): Promise<void> {
    if (!order) return;
    try {
      await downloadInvoice(orderId, `${order.invoiceNumber ?? order.number}.pdf`);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : labels.invoicePending);
    }
  }

  if (error) {
    return (
      <div className="account-error" role="alert">
        <p>{labels.loadError}</p>
        <button type="button" className="btn" onClick={load}>
          {labels.retry}
        </button>
      </div>
    );
  }
  if (order === null) return <p className="account-muted">{labels.loading}</p>;

  const addr = order.shippingAddress;
  return (
    <div className="order-detail">
      <p>
        <Link href={ordersPath}>← {labels.back}</Link>
      </p>
      <header className="order-detail-head">
        <div>
          <h2>
            {labels.order} {order.number}
          </h2>
          <p className="account-muted">{fmtDate(order.placedAt, locale)}</p>
        </div>
        <StatusBadge status={order.status} label={order.statusLabel} />
      </header>

      {notice ? (
        <p className="account-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="order-detail-actions">
        {order.hasInvoice ? (
          <button type="button" className="btn" onClick={onDownload}>
            {labels.downloadInvoice}
          </button>
        ) : null}
        {order.canCancel ? (
          <button type="button" className="btn btn-danger" onClick={onCancel} disabled={busy}>
            {busy ? labels.cancelling : labels.cancel}
          </button>
        ) : null}
      </div>

      <section>
        <h3>{labels.items}</h3>
        <table className="orders-table">
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.sku}>
                <td>
                  {locale === 'fr' ? line.nameFr : line.nameEn}
                  <span className="account-muted"> · {line.sku}</span>
                </td>
                <td>× {line.quantity}</td>
                <td>{money(line.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="order-totals">
        <Row label={labels.subtotal} value={money(order.subtotalCents)} />
        {order.discountCents > 0 ? (
          <Row label={labels.discount} value={`−${money(order.discountCents)}`} />
        ) : null}
        <Row
          label={labels.shipping}
          value={order.shippingCents > 0 ? money(order.shippingCents) : labels.free}
        />
        {order.taxGstCents > 0 ? <Row label={labels.gst} value={money(order.taxGstCents)} /> : null}
        {order.taxHstCents > 0 ? <Row label={labels.hst} value={money(order.taxHstCents)} /> : null}
        {order.taxQstCents > 0 ? <Row label={labels.qst} value={money(order.taxQstCents)} /> : null}
        {order.taxPstCents > 0 ? <Row label={labels.pst} value={money(order.taxPstCents)} /> : null}
        <Row label={labels.total} value={money(order.totalCents)} strong />
        {order.cardBrand || order.cardLast4 ? (
          <p className="account-muted">
            {labels.paidWith} {order.cardBrand ?? ''} •••• {order.cardLast4 ?? ''}
          </p>
        ) : null}
      </section>

      <section>
        <h3>{labels.shippingAddress}</h3>
        <address className="order-address">
          {addr.firstName} {addr.lastName}
          {addr.company ? <br /> : null}
          {addr.company}
          <br />
          {addr.line1}
          {addr.line2 ? (
            <>
              <br />
              {addr.line2}
            </>
          ) : null}
          <br />
          {addr.city}, {addr.province} {addr.postalCode}
          <br />
          {addr.country}
        </address>
      </section>

      <section>
        <h3>{labels.timeline}</h3>
        <ol className="order-timeline">
          {order.timeline.map((event, index) => (
            <li key={index}>
              <StatusBadge status={event.status} label={event.label} />
              <span className="account-muted">
                {fmtDate(event.at, locale)} · {actorLabel(event.actor)}
              </span>
              {event.note ? <p className="order-timeline-note">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`order-total-row${strong ? ' is-strong' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
