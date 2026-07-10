'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { type Locale } from '@ffc/i18n';
import {
  AUTH_CHANGED_EVENT,
  isSignedIn,
  listMyShipments,
  type MyShipment,
  NotAuthenticatedError,
  type ShipmentStatus,
  signOutLocal,
} from '@/lib/account-client';
import { SignInForm, type SignInLabels } from './SignInForm';

export interface MesColisLabels {
  signin: SignInLabels;
  title: string;
  empty: string;
  emptyHint: string;
  browse: string;
  active: string;
  history: string;
  order: string;
  viewOrder: string;
  trackOnCarrier: string;
  eta: string;
  deliveredOn: string;
  timeline: string;
  noEvents: string;
  loading: string;
  loadError: string;
  retry: string;
  signOut: string;
  myOrders: string;
}

interface Props {
  locale: Locale;
  labels: MesColisLabels;
  ordersPath: string;
  browsePath: string;
}

const STATUS_TONE: Record<ShipmentStatus, string> = {
  CREATED: 'is-pending',
  PICKED_UP: 'is-processing',
  IN_TRANSIT: 'is-processing',
  OUT_FOR_DELIVERY: 'is-shipped',
  DELIVERED: 'is-delivered',
  EXCEPTION: 'is-exception',
  RETURNED: 'is-refunded',
};

function fmtDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

/** Horodatage LOCAL de l'événement (fuseau du navigateur du client). */
function fmtDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Espace « Mes colis » : porte de connexion, puis colis actifs + historique. */
export function MesColis({ locale, labels, ordersPath, browsePath }: Props) {
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
        <Link className="btn btn-ghost" href={ordersPath}>
          {labels.myOrders}
        </Link>
        <button type="button" className="btn btn-ghost" onClick={() => signOutLocal()}>
          {labels.signOut}
        </button>
      </div>
      <ShipmentsView
        locale={locale}
        labels={labels}
        ordersPath={ordersPath}
        browsePath={browsePath}
      />
    </>
  );
}

function ShipmentsView({ locale, labels, ordersPath, browsePath }: Props) {
  const [shipments, setShipments] = useState<MyShipment[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setShipments(null);
    listMyShipments()
      .then((page) => setShipments(page.items))
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
  if (shipments === null) return <p className="account-muted">{labels.loading}</p>;
  if (shipments.length === 0) {
    return (
      <div className="shipments-empty">
        <span className="shipments-empty-icon" aria-hidden="true">
          📦
        </span>
        <p>{labels.empty}</p>
        <p className="account-muted">{labels.emptyHint}</p>
        <Link className="btn btn-primary" href={browsePath}>
          {labels.browse}
        </Link>
      </div>
    );
  }

  const active = shipments.filter((shipment) => shipment.isActive);
  const history = shipments.filter((shipment) => !shipment.isActive);

  return (
    <div className="shipments">
      {active.length > 0 ? (
        <section>
          <h2>{labels.active}</h2>
          {active.map((shipment) => (
            <ShipmentCard
              key={shipment.id}
              shipment={shipment}
              locale={locale}
              labels={labels}
              ordersPath={ordersPath}
              open
            />
          ))}
        </section>
      ) : null}
      {history.length > 0 ? (
        <section>
          <h2>{labels.history}</h2>
          {history.map((shipment) => (
            <ShipmentCard
              key={shipment.id}
              shipment={shipment}
              locale={locale}
              labels={labels}
              ordersPath={ordersPath}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function ShipmentCard({
  shipment,
  locale,
  labels,
  ordersPath,
  open,
}: {
  shipment: MyShipment;
  locale: Locale;
  labels: MesColisLabels;
  ordersPath: string;
  open?: boolean;
}) {
  return (
    <article className="shipment-card">
      <header className="shipment-card-head">
        <div>
          <p className="shipment-carrier">
            {shipment.carrierLabel ?? '—'}
            {shipment.trackingNumber ? (
              <span className="account-muted"> · {shipment.trackingNumber}</span>
            ) : null}
          </p>
          <p className="account-muted shipment-order-line">
            {labels.order}{' '}
            <Link href={`${ordersPath}/${shipment.orderId}`}>{shipment.orderNumber}</Link>
          </p>
        </div>
        <span className={`order-badge ${STATUS_TONE[shipment.status]}`}>
          {shipment.statusLabel}
        </span>
      </header>

      {shipment.status === 'DELIVERED' && shipment.deliveredAt ? (
        <p className="shipment-eta">
          {labels.deliveredOn} {fmtDate(shipment.deliveredAt, locale)}
        </p>
      ) : shipment.isActive && shipment.estimatedDeliveryAt ? (
        <p className="shipment-eta">
          {labels.eta} {fmtDate(shipment.estimatedDeliveryAt, locale)}
        </p>
      ) : null}

      <details className="shipment-timeline" open={open}>
        <summary>
          {labels.timeline}
          {shipment.events.length > 0 ? ` (${shipment.events.length})` : ''}
        </summary>
        {shipment.events.length === 0 ? (
          <p className="account-muted">{labels.noEvents}</p>
        ) : (
          <ol className="order-timeline">
            {shipment.events.map((event, index) => (
              <li key={index}>
                <span className="shipment-event-label">
                  {event.statusLabel ?? event.description ?? event.code ?? '—'}
                </span>
                <span className="account-muted">
                  {fmtDateTime(event.occurredAt, locale)}
                  {event.location ? ` · ${event.location}` : ''}
                </span>
                {event.statusLabel && event.description ? (
                  <p className="order-timeline-note">{event.description}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </details>

      {shipment.trackingUrl ? (
        <p className="shipment-external">
          <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer">
            {labels.trackOnCarrier} ↗
          </a>
        </p>
      ) : null}
    </article>
  );
}
