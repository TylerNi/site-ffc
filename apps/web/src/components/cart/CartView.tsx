'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Locale } from '@ffc/i18n';
import {
  ApiError,
  type Cart,
  type CartChanges,
  type CartLine,
  fetchCart,
  removeCartItem,
  updateCartItem,
} from '@/lib/cart-client';

export interface CartViewLabels {
  title: string;
  empty: string;
  browse: string;
  product: string;
  price: string;
  quantity: string;
  total: string;
  remove: string;
  decrease: string;
  increase: string;
  subtotal: string;
  taxesAtCheckout: string;
  checkout: string;
  continueShopping: string;
  loading: string;
  loadError: string;
  retry: string;
  updateError: string;
  removedUnavailable: string;
  removedOutOfStock: string;
  adjusted: string;
  priceChanged: string;
  onlyLeft: string;
  merv: string;
  packSingle: string;
  packBox: string;
}

interface CartViewProps {
  locale: Locale;
  labels: CartViewLabels;
  checkoutPath: string;
  browsePath: string;
  productBasePath: string;
}

/** Remplit un gabarit « {name} … {from} {to} {count} » précompilé serveur. */
function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function formatMoney(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

function lineName(line: CartLine, locale: Locale): string {
  return locale === 'fr' ? line.nameFr : line.nameEn;
}

/** Messages d'écarts (produit retiré, quantité rabattue, prix modifié). */
function changeMessages(changes: CartChanges, labels: CartViewLabels, locale: Locale): string[] {
  const name = (entry: { nameFr: string; nameEn: string }) =>
    locale === 'fr' ? entry.nameFr : entry.nameEn;
  return [
    ...changes.removed.map((entry) =>
      fill(entry.reason === 'OUT_OF_STOCK' ? labels.removedOutOfStock : labels.removedUnavailable, {
        name: name(entry),
      }),
    ),
    ...changes.adjusted.map((entry) =>
      fill(labels.adjusted, { name: name(entry), from: entry.fromQuantity, to: entry.toQuantity }),
    ),
    ...changes.priceChanged.map((entry) =>
      fill(labels.priceChanged, {
        name: name(entry),
        from: formatMoney(entry.fromCents, 'CAD', locale),
        to: formatMoney(entry.toCents, 'CAD', locale),
      }),
    ),
  ];
}

/**
 * Page panier (client) : lecture au montage, mutations optimistes rendues
 * par l'état COMPLET retourné par l'API (jamais de calcul local de prix).
 * Les écarts détectés par la revalidation serveur s'affichent en bandeau.
 */
export function CartView({
  locale,
  labels,
  checkoutPath,
  browsePath,
  productBasePath,
}: CartViewProps) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notices, setNotices] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);

  const absorbCart = useCallback(
    (next: Cart) => {
      setCart(next);
      const messages = changeMessages(next.changes, labels, locale);
      if (messages.length > 0) setNotices((current) => [...current, ...messages]);
    },
    [labels, locale],
  );

  const load = useCallback(() => {
    setPhase('loading');
    fetchCart()
      .then((next) => {
        absorbCart(next);
        setPhase('ready');
      })
      .catch(() => setPhase('error'));
  }, [absorbCart]);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = async (variantId: string, action: () => Promise<Cart>) => {
    setBusyLine(variantId);
    setActionError(null);
    try {
      absorbCart(await action());
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'INSUFFICIENT_STOCK') {
        const available = Number(cause.body.availableQuantity ?? 0);
        setActionError(fill(labels.onlyLeft, { count: available }));
      } else {
        setActionError(labels.updateError);
      }
    } finally {
      setBusyLine(null);
    }
  };

  if (phase === 'loading') {
    return <p className="muted">{labels.loading}</p>;
  }
  if (phase === 'error' || !cart) {
    return (
      <div className="empty-state">
        <p>{labels.loadError}</p>
        <button type="button" className="btn" onClick={load}>
          {labels.retry}
        </button>
      </div>
    );
  }

  return (
    <div>
      {notices.length > 0 && (
        <div className="notice cart-notices" role="status">
          {notices.map((message, index) => (
            <p key={index}>{message}</p>
          ))}
        </div>
      )}
      {actionError && (
        <p className="cart-error" role="alert">
          {actionError}
        </p>
      )}

      {cart.items.length === 0 ? (
        <div className="empty-state">
          <p>{labels.empty}</p>
          <a className="btn" href={browsePath}>
            {labels.browse}
          </a>
        </div>
      ) : (
        <div className="cart-layout">
          <ul className="cart-lines">
            {cart.items.map((line) => {
              const slug = locale === 'fr' ? line.slugFr : line.slugEn;
              const name = lineName(line, locale);
              return (
                <li key={line.variantId} className="cart-line">
                  <div className="cart-line-body">
                    <p className="cart-line-name">
                      {slug ? <a href={`${productBasePath}/${slug}`}>{name}</a> : name}
                    </p>
                    <p className="muted small">
                      {[
                        line.nominalLabel,
                        line.merv ? fill(labels.merv, { merv: line.merv }) : null,
                        line.packSize > 1
                          ? fill(labels.packBox, { count: line.packSize })
                          : labels.packSingle,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    <p className="cart-line-price muted">
                      {formatMoney(line.unitPriceCents, line.currency, locale)}
                    </p>
                  </div>

                  <div className="cart-line-actions">
                    <div className="qty-stepper" aria-label={labels.quantity}>
                      <button
                        type="button"
                        aria-label={labels.decrease}
                        disabled={busyLine === line.variantId || line.quantity <= 1}
                        onClick={() =>
                          void mutate(line.variantId, () =>
                            updateCartItem(line.variantId, line.quantity - 1),
                          )
                        }
                      >
                        −
                      </button>
                      <span aria-live="polite">{line.quantity}</span>
                      <button
                        type="button"
                        aria-label={labels.increase}
                        disabled={
                          busyLine === line.variantId || line.quantity >= line.availableQuantity
                        }
                        onClick={() =>
                          void mutate(line.variantId, () =>
                            updateCartItem(line.variantId, line.quantity + 1),
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                    <p className="cart-line-total price">
                      {formatMoney(line.lineSubtotalCents, line.currency, locale)}
                    </p>
                    <button
                      type="button"
                      className="btn-ghost cart-remove"
                      disabled={busyLine === line.variantId}
                      onClick={() =>
                        void mutate(line.variantId, () => removeCartItem(line.variantId))
                      }
                    >
                      {labels.remove}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <aside className="cart-summary card">
            <div className="cart-summary-row">
              <span>{labels.subtotal}</span>
              <strong>{formatMoney(cart.subtotalCents, cart.currency, locale)}</strong>
            </div>
            <p className="muted small">{labels.taxesAtCheckout}</p>
            <a className="btn cart-checkout-btn" href={checkoutPath}>
              {labels.checkout}
            </a>
            <a className="cart-continue" href={browsePath}>
              {labels.continueShopping}
            </a>
          </aside>
        </div>
      )}
    </div>
  );
}
