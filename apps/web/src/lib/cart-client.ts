'use client';

/**
 * Accès NAVIGATEUR au panier et au checkout (tâche 11).
 *
 * Le jeton de panier invité vit dans localStorage (panier persistant entre
 * visites) et voyage dans l'en-tête X-Cart-Token. L'API répond toujours
 * l'état complet et revalidé du panier — aucun calcul de prix ici.
 *
 * Les composants s'abonnent au nombre d'articles via l'événement
 * `ffc:cart-updated` (badge d'en-tête) — pas de contexte React global à
 * travers la frontière serveur/client.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'ffc.cartToken';
export const CART_UPDATED_EVENT = 'ffc:cart-updated';

/* ------------------------------ Types (API) ------------------------------ */

export interface CartLine {
  variantId: string;
  productId: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  currency: 'CAD' | 'USD';
  lineSubtotalCents: number;
  nameFr: string;
  nameEn: string;
  slugFr?: string | null;
  slugEn?: string | null;
  nominalLabel?: string | null;
  packSize: number;
  merv?: number | null;
  imageUrl?: string | null;
  availableQuantity: number;
}

export interface CartChanges {
  removed: Array<{ sku: string; nameFr: string; nameEn: string; reason: string }>;
  adjusted: Array<{
    sku: string;
    nameFr: string;
    nameEn: string;
    fromQuantity: number;
    toQuantity: number;
  }>;
  priceChanged: Array<{
    sku: string;
    nameFr: string;
    nameEn: string;
    fromCents: number;
    toCents: number;
  }>;
}

export interface Cart {
  id: string | null;
  guestCartToken?: string | null;
  currency: 'CAD' | 'USD';
  items: CartLine[];
  subtotalCents: number;
  itemCount: number;
  changes: CartChanges;
}

export interface OrderLineSummary {
  sku: string;
  nameFr: string;
  nameEn: string;
  nominalLabel?: string | null;
  packSize: number;
  merv?: number | null;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface OrderSummary {
  id: string;
  number: string;
  currency: 'CAD' | 'USD';
  email: string;
  lines: OrderLineSummary[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxGstCents: number;
  taxQstCents: number;
  taxHstCents: number;
  taxPstCents: number;
  totalTaxCents: number;
  totalCents: number;
  couponCode?: string | null;
  shippingAddress: {
    firstName: string;
    lastName: string;
    company?: string | null;
    line1: string;
    line2?: string | null;
    city: string;
    province: string;
    postalCode: string;
    country: 'CA' | 'US';
    phone?: string | null;
  };
}

export interface CheckoutSession {
  clientSecret: string;
  paymentIntentId: string;
  order: OrderSummary;
}

export type CheckoutResultStatus =
  | 'paid'
  | 'processing'
  | 'requires_action'
  | 'payment_failed'
  | 'cancelled'
  | 'cancelled_insufficient_stock';

export interface CheckoutResult {
  status: CheckoutResultStatus;
  order?: OrderSummary | null;
  failureMessage?: string | null;
}

/** Erreur d'API avec le corps structuré (code, changes, issues…). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : `HTTP ${status}`);
  }

  get code(): string | undefined {
    return typeof this.body.code === 'string' ? this.body.code : undefined;
  }
}

/* ------------------------------ Jeton invité ----------------------------- */

export function getCartToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // stockage bloqué (navigation privée stricte) : panier de session
  }
}

function setCartToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* au pire, le panier ne survivra pas à l'onglet */
  }
}

export function clearCartToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* rien à faire */
  }
}

/* --------------------------------- Requêtes ------------------------------ */

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getCartToken();
  if (token) headers['X-Cart-Token'] = token;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

function notifyCartUpdated(cart: Cart): void {
  window.dispatchEvent(new CustomEvent(CART_UPDATED_EVENT, { detail: { count: cart.itemCount } }));
}

/** Consigne le jeton fraîchement émis et diffuse le nouveau compte. */
function absorb(cart: Cart): Cart {
  if (cart.guestCartToken) setCartToken(cart.guestCartToken);
  notifyCartUpdated(cart);
  return cart;
}

/* --------------------------------- Panier -------------------------------- */

export async function fetchCart(): Promise<Cart> {
  return absorb(await request<Cart>('GET', '/v1/cart'));
}

export async function addToCart(variantId: string, quantity: number): Promise<Cart> {
  return absorb(await request<Cart>('POST', '/v1/cart/items', { variantId, quantity }));
}

export async function updateCartItem(variantId: string, quantity: number): Promise<Cart> {
  return absorb(await request<Cart>('PATCH', `/v1/cart/items/${variantId}`, { quantity }));
}

export async function removeCartItem(variantId: string): Promise<Cart> {
  return absorb(await request<Cart>('DELETE', `/v1/cart/items/${variantId}`));
}

/** Après un paiement réussi : le panier est converti, le jeton ne sert plus. */
export function resetCartAfterPurchase(): void {
  clearCartToken();
  window.dispatchEvent(new CustomEvent(CART_UPDATED_EVENT, { detail: { count: 0 } }));
}

/* -------------------------------- Checkout ------------------------------- */

export interface CheckoutAddressInput {
  firstName: string;
  lastName: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: 'CA' | 'US';
  phone?: string;
}

export interface CreateSessionInput {
  email: string;
  locale: 'fr' | 'en';
  shippingAddress: CheckoutAddressInput;
  couponCode?: string;
  customerNote?: string;
}

export async function createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession> {
  return request<CheckoutSession>('POST', '/v1/checkout/session', input);
}

export async function fetchCheckoutResult(
  paymentIntentId: string,
  clientSecret: string,
): Promise<CheckoutResult> {
  return request<CheckoutResult>('POST', '/v1/checkout/result', { paymentIntentId, clientSecret });
}
