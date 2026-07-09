import { randomUUID } from 'node:crypto';
import { ShipstationError } from '../../src/modules/shipping/shipstation/shipstation.client';
import {
  type ShipstationOrderPayload,
  type ShipstationOrderSummary,
  type ShipstationShipment,
  type ShipstationShipmentsPage,
} from '../../src/modules/shipping/shipstation/shipstation.types';

/** Base d'URL du faux — la garde anti-SSRF du client réel la compare à SHIPSTATION_BASE_URL. */
export const FAKE_SHIPSTATION_BASE_URL = 'https://ssapi.shipstation.com';

interface StoredOrder {
  orderId: number;
  payload: ShipstationOrderPayload;
}

/**
 * Faux ShipStation EN MÉMOIRE — même surface que ShipstationClient.
 *
 * Simule ce qui compte pour la tâche 13 :
 *   - l'upsert par `orderKey` (aucun doublon), et la recherche par numéro ;
 *   - les pannes : réseau/5xx (retentables) et 4xx (définitives), avec la
 *     variante VICIEUSE « ShipStation a bien créé la commande, mais la
 *     réponse s'est perdue » (`failCreateAfterPersist`) ;
 *   - la création d'étiquettes par l'équipe d'expédition (`createLabel`),
 *     exposées ensuite par `resource_url` (webhook) ET par la liste des
 *     expéditions récentes (polling de repli).
 */
export class FakeShipstationClient {
  /**
   * Origine ALÉATOIRE de la séquence : la base ffc_test est partagée entre
   * fichiers et `shipments.shipstation_shipment_id` est unique. Deux fausses
   * instances qui repartiraient de 1000 se marcheraient dessus (même piège
   * que les identifiants du faux Stripe, préfixés par un runId).
   */
  private sequence = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  private readonly orders = new Map<string, StoredOrder>();
  private readonly shipments: ShipstationShipment[] = [];
  private readonly resources = new Map<string, number[]>();

  /** Nombre d'appels de création — assertion « aucun doublon ». */
  createCalls = 0;
  findCalls = 0;

  /**
   * Pannes programmées. `network` et `permanent` frappent N'IMPORTE quel
   * appel (le premier venu) ; `createAfterPersist` ne frappe QUE la création,
   * car il simule précisément « ShipStation a créé, la réponse s'est perdue ».
   */
  private networkFailures = 0;
  private permanentFailures = 0;
  private createAfterPersistFailures = 0;
  private configured = true;

  /* ------------------------- Programmation du faux ----------------------- */

  /** Les `count` prochains appels échouent (réseau : retentable). */
  failNetwork(count: number): void {
    this.networkFailures += count;
  }

  /**
   * Les `count` prochaines CRÉATIONS aboutissent chez ShipStation puis la
   * réponse se perd : une retentative naïve créerait un doublon.
   */
  failCreateAfterPersist(count: number): void {
    this.createAfterPersistFailures += count;
  }

  /** Les `count` prochains appels échouent définitivement (payload refusé, clés révoquées). */
  failPermanently(count = 1): void {
    this.permanentFailures += count;
  }

  clearFailures(): void {
    this.networkFailures = 0;
    this.permanentFailures = 0;
    this.createAfterPersistFailures = 0;
  }

  setConfigured(value: boolean): void {
    this.configured = value;
  }

  /* --------------------------- Surface du client ------------------------- */

  isConfigured(): boolean {
    return this.configured;
  }

  async findOrderByNumber(orderNumber: string): Promise<ShipstationOrderSummary | null> {
    this.findCalls += 1;
    this.maybeFail('GET /orders');
    const stored = this.orders.get(orderNumber);
    return stored ? this.summarize(stored) : null;
  }

  async createOrUpdateOrder(payload: ShipstationOrderPayload): Promise<ShipstationOrderSummary> {
    this.createCalls += 1;
    if (this.createAfterPersistFailures > 0) {
      this.createAfterPersistFailures -= 1;
      this.persist(payload);
      throw new ShipstationError('Délai dépassé après création', null, true);
    }
    this.maybeFail('POST /orders/createorder');
    return this.summarize(this.persist(payload));
  }

  async listShipmentsSince(_since: Date, page = 1): Promise<ShipstationShipmentsPage> {
    this.maybeFail('GET /shipments');
    return { shipments: [...this.shipments], total: this.shipments.length, page, pages: 1 };
  }

  async fetchWebhookResource(resourceUrl: string): Promise<ShipstationShipmentsPage> {
    this.maybeFail('GET resource_url');
    if (!resourceUrl.startsWith(FAKE_SHIPSTATION_BASE_URL)) {
      throw new ShipstationError(`resource_url hors domaine : ${resourceUrl}`, null, false);
    }
    const ids = this.resources.get(resourceUrl);
    if (!ids) throw new ShipstationError(`resource_url inconnue : ${resourceUrl}`, 404, false);
    const shipments = this.shipments.filter((shipment) => ids.includes(shipment.shipmentId));
    return { shipments, total: shipments.length, page: 1, pages: 1 };
  }

  /* ----------------------------- Aides de test --------------------------- */

  /** État d'une commande côté ShipStation (assertions). */
  order(orderNumber: string): ShipstationOrderPayload | undefined {
    return this.orders.get(orderNumber)?.payload;
  }

  orderCount(): number {
    return this.orders.size;
  }

  /**
   * L'équipe d'expédition crée une étiquette. Retourne le corps du webhook
   * que ShipStation enverrait — le lot est aussi visible par le polling.
   */
  createLabel(
    orderNumber: string,
    overrides: Partial<ShipstationShipment> = {},
  ): { body: { resource_url: string; resource_type: string }; shipment: ShipstationShipment } {
    const stored = this.orders.get(orderNumber);
    if (!stored) throw new Error(`Commande ${orderNumber} absente du faux ShipStation`);

    this.sequence += 1;
    const shipment: ShipstationShipment = {
      shipmentId: this.sequence,
      orderId: stored.orderId,
      orderKey: stored.payload.orderKey,
      orderNumber,
      createDate: new Date().toISOString(),
      shipDate: new Date().toISOString(),
      trackingNumber: `1Z${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`,
      carrierCode: 'canada_post',
      serviceCode: 'canada_post_expedited_parcel',
      shipmentCost: 14.75,
      insuranceCost: 0,
      voided: false,
      weight: { value: 1200, units: 'grams' },
      dimensions: { units: 'inches', length: 20, width: 20, height: 4 },
      advancedOptions: { customField1: stored.payload.advancedOptions.customField1 },
      ...overrides,
    };
    this.shipments.push(shipment);

    const resourceUrl = `${FAKE_SHIPSTATION_BASE_URL}/shipments?batchId=${randomUUID()}`;
    this.resources.set(resourceUrl, [shipment.shipmentId]);
    return { body: { resource_url: resourceUrl, resource_type: 'SHIP_NOTIFY' }, shipment };
  }

  /** Plusieurs colis pour une même commande, livrés par un seul webhook. */
  createLabels(
    orderNumber: string,
    count: number,
  ): { body: { resource_url: string; resource_type: string }; shipments: ShipstationShipment[] } {
    const shipments = Array.from({ length: count }, () => this.createLabel(orderNumber).shipment);
    const resourceUrl = `${FAKE_SHIPSTATION_BASE_URL}/shipments?batchId=${randomUUID()}`;
    this.resources.set(
      resourceUrl,
      shipments.map((shipment) => shipment.shipmentId),
    );
    return { body: { resource_url: resourceUrl, resource_type: 'SHIP_NOTIFY' }, shipments };
  }

  /* -------------------------------- Interne ------------------------------ */

  private persist(payload: ShipstationOrderPayload): StoredOrder {
    const existing = this.orders.get(payload.orderKey);
    const stored: StoredOrder = existing
      ? { orderId: existing.orderId, payload }
      : { orderId: (this.sequence += 1), payload };
    this.orders.set(payload.orderKey, stored);
    return stored;
  }

  private summarize(stored: StoredOrder): ShipstationOrderSummary {
    return {
      orderId: stored.orderId,
      orderNumber: stored.payload.orderNumber,
      orderKey: stored.payload.orderKey,
      orderStatus: stored.payload.orderStatus,
    };
  }

  private maybeFail(operation: string): void {
    if (this.permanentFailures > 0) {
      this.permanentFailures -= 1;
      throw new ShipstationError(`${operation} → 401 Unauthorized`, 401, false);
    }
    if (this.networkFailures > 0) {
      this.networkFailures -= 1;
      throw new ShipstationError(`ECONNRESET (${operation})`, null, true);
    }
  }
}
