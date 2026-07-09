import { type Locale } from '@ffc/core';
import {
  type ShipstationAddress,
  type ShipstationOrderItem,
  type ShipstationOrderPayload,
  type ShipstationOrderStatus,
} from './shipstation.types';

/**
 * Traduction commande FFC → commande ShipStation (fonctions PURES, testées
 * seules). Le tableau de correspondance des champs est reproduit dans
 * `docs/shipstation.md` — toute modification ici doit y être répercutée.
 *
 * Deux règles tiennent l'intégration :
 *   - `orderNumber` ET `orderKey` valent notre numéro de commande : c'est la
 *     RÉFÉRENCE EXTERNE qui rend la création idempotente (upsert ShipStation) ;
 *   - `advancedOptions.customField1` porte notre UUID de commande : les
 *     expéditions qui reviennent sont rattachées sans ambiguïté, même si
 *     quelqu'un renomme la commande dans ShipStation.
 */

/** Poids retenu quand la variante n'en déclare pas (produit importé sans poids). */
export const DEFAULT_UNIT_WEIGHT_GRAMS = 500;

/** Adresse figée dans la commande (instantané JSONB de la tâche 11). */
export interface OrderAddressSnapshot {
  firstName: string;
  lastName: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone?: string | null;
}

export interface MappedOrderItem {
  id: string;
  sku: string;
  nameFr: string;
  nameEn: string;
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
  /** Poids d'expédition d'UNE unité vendable (boîte), en grammes. */
  weightGrams: number | null;
}

export interface MappedOrder {
  id: string;
  number: string;
  locale: Locale;
  paidAt: Date | null;
  placedAt: Date;
  customerEmail: string | null;
  shippingAddress: OrderAddressSnapshot;
  billingAddress: OrderAddressSnapshot | null;
  items: MappedOrderItem[];
  discountCents: number;
  shippingCents: number;
  totalTaxCents: number;
  totalCents: number;
  customerNote: string | null;
}

export interface BuildOrderPayloadOptions {
  storeId?: number;
  status?: ShipstationOrderStatus;
  /** Identifiant ShipStation connu (mise à jour d'une commande existante). */
  shipstationOrderId?: number;
}

/** Montant en cents → dollars, arrondi au cent (l'API ne prend que des dollars). */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

function fullName(address: OrderAddressSnapshot): string {
  return `${address.firstName} ${address.lastName}`.trim();
}

export function toShipstationAddress(address: OrderAddressSnapshot): ShipstationAddress {
  return {
    name: fullName(address),
    company: address.company?.trim() || null,
    street1: address.line1,
    street2: address.line2?.trim() || null,
    city: address.city,
    state: address.province,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone?.trim() || null,
    // Inconnu : ShipStation applique alors la règle du transporteur.
    residential: null,
  };
}

export function itemWeightGrams(item: MappedOrderItem): number {
  return item.weightGrams && item.weightGrams > 0 ? item.weightGrams : DEFAULT_UNIT_WEIGHT_GRAMS;
}

export function totalWeightGrams(items: readonly MappedOrderItem[]): number {
  return items.reduce((sum, item) => sum + itemWeightGrams(item) * item.quantity, 0);
}

function toShipstationItem(item: MappedOrderItem, locale: Locale): ShipstationOrderItem {
  return {
    // Stable : un rejeu met à jour la même ligne plutôt que d'en ajouter une.
    lineItemKey: item.id,
    sku: item.sku,
    name: locale === 'fr' ? item.nameFr : item.nameEn,
    quantity: item.quantity,
    unitPrice: centsToDollars(item.unitPriceCents),
    taxAmount: centsToDollars(item.taxCents),
    weight: { value: itemWeightGrams(item), units: 'grams' },
  };
}

/**
 * Notes internes destinées à l'équipe d'expédition — elles s'affichent en
 * évidence dans ShipStation. On y met ce qui change une décision d'emballage
 * ou de transporteur, jamais du bavardage.
 */
export function internalNotesFor(order: MappedOrder): string | null {
  const notes: string[] = [];
  if (order.shippingAddress.country === 'US') {
    notes.push(
      'LIVRAISON ÉTATS-UNIS — déclaration douanière requise ; droits et taxes à l’importation à la charge du client.',
    );
  }
  if (order.discountCents > 0) {
    notes.push(`Remise appliquée : ${centsToDollars(order.discountCents).toFixed(2)} $ CA.`);
  }
  if (order.items.some((item) => !item.weightGrams || item.weightGrams <= 0)) {
    notes.push(
      `Poids manquant sur au moins un article — ${DEFAULT_UNIT_WEIGHT_GRAMS} g/unité présumés, à peser.`,
    );
  }
  return notes.length > 0 ? notes.join('\n') : null;
}

/** Commande FFC → corps de `POST /orders/createorder`. */
export function buildOrderPayload(
  order: MappedOrder,
  options: BuildOrderPayloadOptions = {},
): ShipstationOrderPayload {
  const shipTo = toShipstationAddress(order.shippingAddress);
  const billTo = order.billingAddress ? toShipstationAddress(order.billingAddress) : shipTo;

  return {
    ...(options.shipstationOrderId ? { orderId: options.shipstationOrderId } : {}),
    orderNumber: order.number,
    orderKey: order.number,
    orderDate: (order.paidAt ?? order.placedAt).toISOString(),
    paymentDate: order.paidAt ? order.paidAt.toISOString() : null,
    orderStatus: options.status ?? 'awaiting_shipment',
    customerUsername: order.customerEmail,
    customerEmail: order.customerEmail,
    billTo,
    shipTo,
    items: order.items.map((item) => toShipstationItem(item, order.locale)),
    amountPaid: centsToDollars(order.totalCents),
    taxAmount: centsToDollars(order.totalTaxCents),
    shippingAmount: centsToDollars(order.shippingCents),
    customerNotes: order.customerNote?.trim() || null,
    internalNotes: internalNotesFor(order),
    gift: false,
    weight: { value: totalWeightGrams(order.items), units: 'grams' },
    advancedOptions: {
      ...(options.storeId ? { storeId: options.storeId } : {}),
      customField1: order.id,
      customField2: order.locale,
    },
  };
}
