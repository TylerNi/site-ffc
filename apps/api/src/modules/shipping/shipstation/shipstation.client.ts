import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../../config/env';
import {
  type ShipstationOrderPayload,
  type ShipstationOrdersPage,
  type ShipstationOrderSummary,
  type ShipstationShipmentsPage,
} from './shipstation.types';

/** Délai d'attente réseau d'un appel ShipStation. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Erreur d'appel ShipStation. `retryable` distingue ce qui mérite une
 * retentative (réseau, 429, 5xx) de ce qui est définitivement refusé
 * (payload invalide, clés révoquées) et doit rejoindre la file d'échec.
 */
export class ShipstationError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ShipstationError';
  }
}

/**
 * Enveloppe INJECTABLE de l'API ShipStation V1 — la seule porte vers
 * ShipStation. Trois responsabilités, et rien d'autre :
 *
 *   1. **Authentification** Basic (clé/secret) et sérialisation JSON ;
 *   2. **Throttling** : l'API tolère 40 requêtes/minute par compte. Les
 *      appels sont SÉRIALISÉS et espacés d'un intervalle minimal ; les
 *      en-têtes `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` (et un 429)
 *      repoussent l'appel suivant jusqu'à la réinitialisation du quota ;
 *   3. **Classification des erreurs** : `retryable` pilote le recul
 *      exponentiel de la file de synchronisation (shipstation_syncs).
 *
 * Sans clés (dev sans accès) : `isConfigured()` est faux et tout appel
 * réseau lève 503 — la file conserve les commandes, rien n'est perdu.
 * Les tests substituent ce provider par un faux en mémoire.
 */
@Injectable()
export class ShipstationClient {
  private readonly logger = new Logger(ShipstationClient.name);
  private readonly baseUrl: string;
  private readonly authorization: string | null;
  private readonly minIntervalMs: number;

  /** File d'attente : un seul appel ShipStation à la fois, espacés. */
  private chain: Promise<unknown> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('SHIPSTATION_BASE_URL', { infer: true }).replace(/\/$/, '');
    const key = config.get('SHIPSTATION_API_KEY', { infer: true });
    const secret = config.get('SHIPSTATION_API_SECRET', { infer: true });
    this.authorization =
      key && secret ? `Basic ${Buffer.from(`${key}:${secret}`, 'utf8').toString('base64')}` : null;
    this.minIntervalMs = Math.ceil(
      60_000 / config.get('SHIPSTATION_RATE_LIMIT_PER_MINUTE', { infer: true }),
    );
    if (!this.authorization) {
      this.logger.warn('Clés ShipStation absentes — la poussée des commandes reste en file.');
    }
  }

  isConfigured(): boolean {
    return this.authorization !== null;
  }

  /* ---------------------------- Commandes ------------------------------- */

  /**
   * Recherche par RÉFÉRENCE EXTERNE (notre numéro de commande) — appelée
   * avant toute création : un job rejoué ne crée jamais de doublon.
   */
  async findOrderByNumber(orderNumber: string): Promise<ShipstationOrderSummary | null> {
    const page = await this.request<ShipstationOrdersPage>(
      'GET',
      `/orders?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=50`,
    );
    return page.orders.find((order) => order.orderNumber === orderNumber) ?? null;
  }

  /**
   * Crée OU met à jour une commande. ShipStation fait un upsert sur
   * `orderKey` : ceinture (recherche préalable) et bretelles (clé stable).
   */
  createOrUpdateOrder(payload: ShipstationOrderPayload): Promise<ShipstationOrderSummary> {
    return this.request<ShipstationOrderSummary>('POST', '/orders/createorder', payload);
  }

  /* ---------------------------- Expéditions ----------------------------- */

  /** Expéditions modifiées depuis `since` (repli de polling). */
  listShipmentsSince(since: Date, page = 1): Promise<ShipstationShipmentsPage> {
    const params = new URLSearchParams({
      createDateStart: toShipstationDate(since),
      includeShipmentItems: 'false',
      sortBy: 'CreateDate',
      sortDir: 'ASC',
      page: String(page),
      pageSize: '100',
    });
    return this.request<ShipstationShipmentsPage>('GET', `/shipments?${params.toString()}`);
  }

  /**
   * Suit le `resource_url` d'un webhook. L'URL vient d'un appelant NON
   * authentifié : on refuse tout ce qui ne pointe pas exactement sur
   * l'origine ShipStation configurée (parade SSRF).
   */
  fetchWebhookResource(resourceUrl: string): Promise<ShipstationShipmentsPage> {
    let parsed: URL;
    try {
      parsed = new URL(resourceUrl);
    } catch {
      throw new ShipstationError(`resource_url invalide : ${resourceUrl}`, null, false);
    }
    if (parsed.origin !== new URL(this.baseUrl).origin) {
      throw new ShipstationError(
        `resource_url hors du domaine ShipStation attendu (${parsed.origin})`,
        null,
        false,
      );
    }
    return this.request<ShipstationShipmentsPage>(
      'GET',
      `${parsed.pathname}${parsed.search}`.replace(/^\/?/, '/'),
    );
  }

  /* ------------------------------ Transport ----------------------------- */

  /** Sérialise les appels et respecte l'intervalle minimal entre deux. */
  private request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const run = this.chain.then(
      () => this.throttledFetch<T>(method, path, body),
      () => this.throttledFetch<T>(method, path, body),
    );
    // La chaîne ne doit jamais rester rejetée : elle sert d'horloge, pas d'état.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async throttledFetch<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.authorization) {
      throw new ServiceUnavailableException(
        'ShipStation n’est pas configuré sur ce serveur (clé API absente).',
      );
    }
    await this.waitForSlot();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // Panne réseau / délai dépassé : toujours retentable.
      const message = error instanceof Error ? error.message : String(error);
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
      throw new ShipstationError(`Appel ShipStation ${method} ${path} : ${message}`, null, true);
    } finally {
      clearTimeout(timeout);
    }

    this.applyRateLimitHeaders(response);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable =
        response.status === 429 || response.status === 408 || response.status >= 500;
      if (response.status === 429) {
        this.logger.warn('Quota ShipStation atteint (429) — appel suivant reporté.');
      }
      throw new ShipstationError(
        `ShipStation ${method} ${path} → ${response.status} ${response.statusText}`,
        response.status,
        retryable,
        text.slice(0, 500),
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async waitForSlot(): Promise<void> {
    const delay = this.nextAllowedAt - Date.now();
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }

  /**
   * Le quota restant fait autorité sur notre intervalle fixe : à zéro, on
   * attend la réinitialisation annoncée plutôt que de collectionner les 429.
   */
  private applyRateLimitHeaders(response: Response): void {
    const remaining = Number(response.headers.get('x-rate-limit-remaining'));
    const reset = Number(response.headers.get('x-rate-limit-reset'));
    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(reset) && reset > 0) {
      this.nextAllowedAt = Date.now() + reset * 1_000;
      return;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      this.nextAllowedAt =
        Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 60_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ShipStation attend « yyyy-MM-dd HH:mm:ss » (heure locale du compte, UTC accepté). */
export function toShipstationDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
