'use client';

import { useRef, useState } from 'react';
import { addToCart, ApiError } from '@/lib/cart-client';

interface AddToCartProps {
  variantId: string;
  disabled?: boolean;
  labels: {
    add: string;
    adding: string;
    added: string;
    outOfStock: string;
    /** Message avec {count} remplacé côté client (stock restant). */
    insufficient: string;
    error: string;
  };
}

/**
 * Bouton « Ajouter au panier » d'une variante (fiche produit). L'API
 * revalide prix et stock ; en cas de refus (épuisé entre-temps), le
 * message s'affiche sous le bouton. L'événement `ffc:cart-updated`
 * (diffusé par cart-client) met le badge d'en-tête à jour.
 */
export function AddToCart({ variantId, disabled, labels }: AddToCartProps) {
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle');
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onClick = async () => {
    if (state === 'adding') return;
    setState('adding');
    setError(null);
    try {
      await addToCart(variantId, 1);
      setState('added');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setState('idle'), 2000);
    } catch (cause) {
      setState('idle');
      if (cause instanceof ApiError && cause.code === 'INSUFFICIENT_STOCK') {
        const available = Number(cause.body.availableQuantity ?? 0);
        setError(
          available > 0
            ? labels.insufficient.replace('{count}', String(available))
            : labels.outOfStock,
        );
      } else if (cause instanceof ApiError && cause.code === 'UNAVAILABLE') {
        setError(labels.outOfStock);
      } else {
        setError(labels.error);
      }
    }
  };

  if (disabled) {
    return (
      <button type="button" className="btn btn-add" disabled>
        {labels.outOfStock}
      </button>
    );
  }

  return (
    <div className="add-to-cart">
      <button
        type="button"
        className="btn btn-add"
        onClick={() => void onClick()}
        disabled={state === 'adding'}
        aria-live="polite"
      >
        {state === 'adding' ? labels.adding : state === 'added' ? `${labels.added} ✓` : labels.add}
      </button>
      {error && (
        <p className="add-to-cart-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
