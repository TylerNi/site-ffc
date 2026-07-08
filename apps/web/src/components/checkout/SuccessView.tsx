'use client';

import { useEffect, useRef, useState } from 'react';
import { type Locale } from '@ffc/i18n';
import {
  type CheckoutResult,
  fetchCheckoutResult,
  type OrderSummary,
  resetCartAfterPurchase,
} from '@/lib/cart-client';
import { formatMoney } from '@/components/cart/CartView';

export interface SuccessLabels {
  checking: string;
  paidTitle: string;
  paidIntro: string;
  processingTitle: string;
  processingIntro: string;
  failedTitle: string;
  failedIntro: string;
  failedRetry: string;
  cancelledStockTitle: string;
  cancelledStockIntro: string;
  invalidTitle: string;
  invalidIntro: string;
  summary: string;
  shippedTo: string;
  backToShop: string;
  goToCheckout: string;
  subtotal: string;
  shipping: string;
  freeShipping: string;
  discount: string;
  taxGst: string;
  taxQst: string;
  taxHst: string;
  taxPst: string;
  total: string;
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

function Recap({
  order,
  labels,
  locale,
}: {
  order: OrderSummary;
  labels: SuccessLabels;
  locale: Locale;
}) {
  const address = order.shippingAddress;
  const row = (label: string, cents: number) => (
    <div className="summary-row">
      <span>{label}</span>
      <span>{formatMoney(cents, order.currency, locale)}</span>
    </div>
  );
  return (
    <section className="card checkout-summary success-recap">
      <h2>
        {labels.summary} — {order.number}
      </h2>
      <ul className="summary-lines">
        {order.lines.map((line) => (
          <li key={line.sku}>
            <span>
              {line.quantity} × {locale === 'fr' ? line.nameFr : line.nameEn}
            </span>
            <span>{formatMoney(line.subtotalCents, order.currency, locale)}</span>
          </li>
        ))}
      </ul>
      {row(labels.subtotal, order.subtotalCents)}
      {order.discountCents > 0 && (
        <div className="summary-row summary-discount">
          <span>
            {labels.discount}
            {order.couponCode ? ` (${order.couponCode})` : ''}
          </span>
          <span>−{formatMoney(order.discountCents, order.currency, locale)}</span>
        </div>
      )}
      <div className="summary-row">
        <span>{labels.shipping}</span>
        <span>
          {order.shippingCents === 0
            ? labels.freeShipping
            : formatMoney(order.shippingCents, order.currency, locale)}
        </span>
      </div>
      {order.taxGstCents > 0 && row(labels.taxGst, order.taxGstCents)}
      {order.taxQstCents > 0 && row(labels.taxQst, order.taxQstCents)}
      {order.taxHstCents > 0 && row(labels.taxHst, order.taxHstCents)}
      {order.taxPstCents > 0 && row(labels.taxPst, order.taxPstCents)}
      <div className="summary-row summary-total">
        <span>{labels.total}</span>
        <strong>{formatMoney(order.totalCents, order.currency, locale)}</strong>
      </div>

      <h3>{labels.shippedTo}</h3>
      <p className="muted small">
        {address.firstName} {address.lastName}
        <br />
        {address.line1}
        {address.line2 ? <>, {address.line2}</> : null}
        <br />
        {address.city}, {address.province} {address.postalCode} ({address.country})
      </p>
    </section>
  );
}

/**
 * Page de succès : lit `payment_intent` + `payment_intent_client_secret`
 * de l'URL (posés par notre navigation ou par le retour 3DS de Stripe),
 * interroge l'API — qui FINALISE la commande si le webhook n'est pas
 * encore passé — et affiche le récapitulatif. `processing` re-vérifie
 * quelques fois automatiquement.
 */
export function SuccessView({
  locale,
  labels,
  homePath,
  checkoutPath,
}: {
  locale: Locale;
  labels: SuccessLabels;
  homePath: string;
  checkoutPath: string;
}) {
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [phase, setPhase] = useState<'checking' | 'done' | 'invalid'>('checking');
  const attempts = useRef(0);
  const cleared = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const intentId = params.get('payment_intent');
    const clientSecret = params.get('payment_intent_client_secret');
    if (!intentId || !clientSecret) {
      setPhase('invalid');
      return;
    }

    let cancelled = false;
    const check = async () => {
      try {
        const next = await fetchCheckoutResult(intentId, clientSecret);
        if (cancelled) return;
        setResult(next);
        setPhase('done');
        if (
          (next.status === 'paid' || next.status === 'cancelled_insufficient_stock') &&
          !cleared.current
        ) {
          cleared.current = true;
          resetCartAfterPurchase();
        }
        // Paiement encore en traitement : on repasse quelques fois.
        if (next.status === 'processing' && attempts.current < 5) {
          attempts.current += 1;
          setTimeout(() => void check(), 2_500);
        }
      } catch {
        if (!cancelled) setPhase('invalid');
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === 'checking') {
    return <p className="muted">{labels.checking}</p>;
  }

  if (phase === 'invalid' || !result) {
    return (
      <div className="empty-state">
        <h1>{labels.invalidTitle}</h1>
        <p>{labels.invalidIntro}</p>
        <a className="btn" href={homePath}>
          {labels.backToShop}
        </a>
      </div>
    );
  }

  const order = result.order ?? null;

  if (result.status === 'paid') {
    return (
      <div>
        <h1>{labels.paidTitle}</h1>
        {order && <p>{fill(labels.paidIntro, { number: order.number, email: order.email })}</p>}
        {order && <Recap order={order} labels={labels} locale={locale} />}
        <a className="btn" href={homePath}>
          {labels.backToShop}
        </a>
      </div>
    );
  }

  if (result.status === 'processing') {
    return (
      <div>
        <h1>{labels.processingTitle}</h1>
        <p>{labels.processingIntro}</p>
      </div>
    );
  }

  if (result.status === 'cancelled_insufficient_stock') {
    return (
      <div>
        <h1>{labels.cancelledStockTitle}</h1>
        <p>{order ? fill(labels.cancelledStockIntro, { number: order.number }) : null}</p>
        <a className="btn" href={homePath}>
          {labels.backToShop}
        </a>
      </div>
    );
  }

  // payment_failed / requires_action / cancelled : retour à la caisse.
  return (
    <div>
      <h1>{labels.failedTitle}</h1>
      <p>
        {result.failureMessage ?? labels.failedIntro} {labels.failedRetry}
      </p>
      <a className="btn" href={checkoutPath}>
        {labels.goToCheckout}
      </a>
    </div>
  );
}
