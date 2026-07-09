'use client';

/**
 * Accès NAVIGATEUR au compte client (tâche 12) : connexion et espace
 * « Mes commandes ».
 *
 * Session par jetons dans le corps (pas de cookie inter-domaines) : l'access
 * token et le refresh token vivent dans localStorage ; `authFetch` ajoute le
 * Bearer et, sur 401, tente UNE rotation du refresh token avant d'abandonner.
 * Aucun montant n'est calculé ici — l'API fait foi.
 */

import { API_URL, ApiError } from './cart-client';

const ACCESS_KEY = 'ffc.accessToken';
const REFRESH_KEY = 'ffc.refreshToken';
export const AUTH_CHANGED_EVENT = 'ffc:auth-changed';

/* ------------------------------ Types (API) ------------------------------ */

export type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

export interface MyOrderListItem {
  id: string;
  number: string;
  status: OrderStatus;
  statusLabel: string;
  placedAt: string;
  currency: 'CAD' | 'USD';
  totalCents: number;
  itemCount: number;
  canCancel: boolean;
  hasInvoice: boolean;
}

export interface MyOrdersPage {
  items: MyOrderListItem[];
  nextCursor: string | null;
}

export interface OrderStatusEvent {
  status: OrderStatus;
  label: string;
  note: string | null;
  actor: 'client' | 'admin' | 'system';
  at: string;
}

export interface OrderLine {
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

export interface MyOrderDetail {
  id: string;
  number: string;
  status: OrderStatus;
  statusLabel: string;
  placedAt: string;
  currency: 'CAD' | 'USD';
  lines: OrderLine[];
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
  cardBrand?: string | null;
  cardLast4?: string | null;
  timeline: OrderStatusEvent[];
  refunds: Array<{ amountCents: number; at: string; reason?: string | null }>;
  invoiceNumber?: string | null;
  hasInvoice: boolean;
  canCancel: boolean;
}

/* --------------------------------- Session ------------------------------- */

export function isSignedIn(): boolean {
  return getAccessToken() !== null;
}

function getAccessToken(): string | null {
  try {
    return window.localStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

function getRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function storeTokens(accessToken: string, refreshToken: string): void {
  try {
    window.localStorage.setItem(ACCESS_KEY, accessToken);
    window.localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* stockage bloqué : session de l'onglet seulement */
  }
  notifyAuthChanged();
}

export function signOutLocal(): void {
  try {
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* rien à faire */
  }
  notifyAuthChanged();
}

function notifyAuthChanged(): void {
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
}

interface LoginResponse {
  mfaRequired?: boolean;
  accessToken?: string;
  refreshToken?: string;
}

/** Connexion par courriel + mot de passe (comptes clients, sans MFA). */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json().catch(() => ({}))) as LoginResponse & Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, data);
  if (data.mfaRequired || !data.accessToken || !data.refreshToken) {
    // La MFA vise le personnel (admin) — un compte client n'en a pas.
    throw new ApiError(response.status, {
      code: 'MFA_NOT_SUPPORTED',
      message: 'Compte non pris en charge ici.',
    });
  }
  storeTokens(data.accessToken, data.refreshToken);
}

/** Tente une rotation du refresh token. Retourne le nouvel access token. */
async function tryRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const response = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    signOutLocal();
    return null;
  }
  const data = (await response.json().catch(() => ({}))) as LoginResponse;
  if (!data.accessToken || !data.refreshToken) return null;
  storeTokens(data.accessToken, data.refreshToken);
  return data.accessToken;
}

/** Erreur : session absente ou expirée — l'appelant redirige vers la connexion. */
export class NotAuthenticatedError extends Error {}

async function authFetch(
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<Response> {
  let token = getAccessToken();
  if (!token) {
    token = await tryRefresh();
    if (!token) throw new NotAuthenticatedError('Session absente.');
  }
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && attempt === 0) {
    const refreshed = await tryRefresh();
    if (!refreshed) throw new NotAuthenticatedError('Session expirée.');
    return authFetch(method, path, body, attempt + 1);
  }
  return response;
}

async function authJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await authFetch(method, path, body);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

/* ------------------------------ Mes commandes ---------------------------- */

export function listMyOrders(cursor?: string): Promise<MyOrdersPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return authJson<MyOrdersPage>('GET', `/v1/me/orders${query}`);
}

export function getMyOrder(id: string): Promise<MyOrderDetail> {
  return authJson<MyOrderDetail>('GET', `/v1/me/orders/${id}`);
}

export function cancelMyOrder(
  id: string,
): Promise<{ status: OrderStatus; refundAmountCents: number | null }> {
  return authJson('POST', `/v1/me/orders/${id}/cancel`);
}

/** Télécharge la facture (PDF) via un fetch authentifié → téléchargement navigateur. */
export async function downloadInvoice(orderId: string, filename: string): Promise<void> {
  const response = await authFetch('GET', `/v1/me/orders/${orderId}/invoice`);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(response.status, data);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
