'use client';

import { useEffect, useState } from 'react';
import { CART_UPDATED_EVENT, fetchCart } from '@/lib/cart-client';

/** Pictogramme panier (trait, hérite de currentColor). */
function CartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M3 4h2l2.4 12.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.3L21 8H6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="20.6" r="1.4" fill="currentColor" />
      <circle cx="17.6" cy="20.6" r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * Badge du panier (en-tête) : compte d'articles chargé au montage puis mis
 * à jour par l'événement `ffc:cart-updated` que diffuse cart-client à
 * chaque mutation. Le libellé accessible (« Panier ») vient du serveur ;
 * le compte est annoncé comme texte.
 */
export function CartBadge({ label }: { label: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    fetchCart()
      .then((cart) => {
        if (mounted) setCount(cart.itemCount);
      })
      .catch(() => {
        /* API injoignable : badge à 0, le panier réessaiera */
      });

    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ count: number }>).detail;
      if (typeof detail?.count === 'number') setCount(detail.count);
    };
    window.addEventListener(CART_UPDATED_EVENT, onUpdate);
    return () => {
      mounted = false;
      window.removeEventListener(CART_UPDATED_EVENT, onUpdate);
    };
  }, []);

  return (
    <span className="cart-badge">
      <CartIcon />
      <span className="visually-hidden">{label}</span>
      {count > 0 && <span className="cart-badge-count">{count > 99 ? '99+' : count}</span>}
    </span>
  );
}
