/**
 * Formes des objets de l'API ShipStation V1 (https://ssapi.shipstation.com).
 * Volontairement PARTIELLES : seuls les champs que nous produisons ou
 * consommons sont typés. Le mapping complet est documenté dans
 * `docs/shipstation.md`.
 */

/** Adresse ShipStation (billTo / shipTo). */
export interface ShipstationAddress {
  name: string;
  company: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
  residential: boolean | null;
}

export interface ShipstationWeight {
  value: number;
  units: 'grams' | 'ounces' | 'pounds';
}

export interface ShipstationOrderItem {
  lineItemKey: string;
  sku: string;
  name: string;
  quantity: number;
  /** En DOLLARS (l'API ShipStation ne connaît pas les cents). */
  unitPrice: number;
  taxAmount: number;
  weight: ShipstationWeight;
}

/** Statuts ShipStation utilisés par la boutique personnalisée. */
export type ShipstationOrderStatus =
  'awaiting_payment' | 'awaiting_shipment' | 'shipped' | 'on_hold' | 'cancelled';

/** Corps de `POST /orders/createorder` — upsert par `orderKey`. */
export interface ShipstationOrderPayload {
  /** Renseigné seulement lors d'une mise à jour d'une commande déjà connue. */
  orderId?: number;
  orderNumber: string;
  /** RÉFÉRENCE EXTERNE stable : notre numéro de commande. Clé de l'upsert. */
  orderKey: string;
  orderDate: string;
  paymentDate: string | null;
  orderStatus: ShipstationOrderStatus;
  customerUsername: string | null;
  customerEmail: string | null;
  billTo: ShipstationAddress;
  shipTo: ShipstationAddress;
  items: ShipstationOrderItem[];
  amountPaid: number;
  taxAmount: number;
  shippingAmount: number;
  customerNotes: string | null;
  internalNotes: string | null;
  gift: boolean;
  weight: ShipstationWeight;
  advancedOptions: {
    storeId?: number;
    /** Notre UUID de commande — retrouvé tel quel dans les expéditions. */
    customField1: string;
    customField2?: string | null;
  };
}

/** Réponse de `GET /orders` (liste paginée). */
export interface ShipstationOrdersPage {
  orders: ShipstationOrderSummary[];
  total: number;
  page: number;
  pages: number;
}

export interface ShipstationOrderSummary {
  orderId: number;
  orderNumber: string;
  orderKey: string;
  orderStatus: ShipstationOrderStatus;
}

/** Une expédition (étiquette créée). */
export interface ShipstationShipment {
  shipmentId: number;
  orderId: number;
  orderKey: string | null;
  orderNumber: string;
  createDate: string;
  shipDate: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  /** Coût de l'étiquette, en DOLLARS. */
  shipmentCost: number | null;
  insuranceCost: number | null;
  /** Étiquette annulée : on n'expédie PAS la commande sur cette base. */
  voided: boolean;
  weight: ShipstationWeight | null;
  dimensions: { units: string; length: number; width: number; height: number } | null;
  advancedOptions?: { customField1?: string | null } | null;
}

export interface ShipstationShipmentsPage {
  shipments: ShipstationShipment[];
  total: number;
  page: number;
  pages: number;
}

/**
 * Corps du webhook ShipStation. Il ne porte AUCUNE donnée : il faut aller
 * chercher `resource_url` (d'où le repli par polling si l'appel se perd).
 */
export interface ShipstationWebhookBody {
  resource_url: string;
  resource_type: string;
}

/** Le seul type d'événement qui nous intéresse (étiquette créée). */
export const SHIP_NOTIFY = 'SHIP_NOTIFY';
