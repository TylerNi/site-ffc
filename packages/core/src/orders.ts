import { type OrderStatus } from './enums';
import { type Locale, type LocalizedText } from './locales';

/**
 * Machine d'états des commandes (tâche 12) — source de vérité PARTAGÉE
 * entre l'API (validation des transitions, effets) et le web (affichage de
 * la chronologie, bouton « Annuler »).
 *
 * Chemin nominal : `PAID → PROCESSING → SHIPPED → DELIVERED`.
 * Branches : `CANCELLED` (avant expédition seulement) et
 * `REFUNDED / PARTIALLY_REFUNDED` (après paiement).
 *
 * Le détail des montants figés vit dans order_items ; l'historique horodaté
 * avec acteur (client / admin / système) vit dans order_status_history.
 */

/** Libellés bilingues des statuts (chronologie, courriels, factures, UI). */
export const ORDER_STATUS_LABELS: Record<OrderStatus, LocalizedText> = {
  PENDING: { fr: 'En attente de paiement', en: 'Awaiting payment' },
  PAID: { fr: 'Payée', en: 'Paid' },
  PROCESSING: { fr: 'En préparation', en: 'Processing' },
  SHIPPED: { fr: 'Expédiée', en: 'Shipped' },
  DELIVERED: { fr: 'Livrée', en: 'Delivered' },
  CANCELLED: { fr: 'Annulée', en: 'Cancelled' },
  REFUNDED: { fr: 'Remboursée', en: 'Refunded' },
  PARTIALLY_REFUNDED: { fr: 'Remboursée partiellement', en: 'Partially refunded' },
};

export function orderStatusLabel(status: OrderStatus, locale: Locale): string {
  return ORDER_STATUS_LABELS[status][locale];
}

/**
 * Transitions AUTORISÉES par statut de départ. Toute transition absente de
 * cette table est un « saut illégal » rejeté par l'API.
 *
 * Notes :
 *   - `CANCELLED` n'est atteignable qu'avant l'expédition (PENDING, PAID,
 *     PROCESSING) : une commande expédiée ne s'annule plus, elle se
 *     rembourse (retour).
 *   - `PARTIALLY_REFUNDED → PARTIALLY_REFUNDED` est permis (plusieurs
 *     remboursements partiels) et peut encore aller vers `REFUNDED`.
 *   - `CANCELLED` et `REFUNDED` sont terminaux (le retour des fonds d'une
 *     commande annulée se trace dans refunds, sans changer le statut).
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  PROCESSING: ['SHIPPED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  DELIVERED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'PARTIALLY_REFUNDED', 'SHIPPED', 'DELIVERED'],
  CANCELLED: [],
  REFUNDED: [],
};

/** true si `to` est une transition légale depuis `from`. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Statuts depuis lesquels le CLIENT peut annuler lui-même sa commande —
 * « tant qu'elle n'est pas poussée à l'expédition ». PENDING est exclu
 * (aucun paiement à rembourser : la session expire d'elle-même).
 */
export const CLIENT_CANCELLABLE_STATUSES: readonly OrderStatus[] = ['PAID', 'PROCESSING'];

export function isClientCancellable(status: OrderStatus): boolean {
  return CLIENT_CANCELLABLE_STATUSES.includes(status);
}

/** Statuts « vivants » (ni annulés, ni entièrement remboursés). */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].length === 0;
}
