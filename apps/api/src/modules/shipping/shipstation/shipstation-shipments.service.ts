import { Injectable, Logger } from '@nestjs/common';
import { type Order } from '@prisma/client';
import { carrierLabel, type Locale, normalizeCarrierCode, trackingUrlFor } from '@ffc/core';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { OrderLifecycleService } from '../../orders/lifecycle/order-lifecycle.service';
import { ShipstationClient } from './shipstation.client';
import { markShipstationLabelCreated } from './shipstation-outbox';
import { type ShipstationShipment } from './shipstation.types';
import { TRACKING_FIRST_POLL_DELAY_MS } from '../tracking/tracking-poller.service';

/**
 * Fenêtre du polling de repli. Généreuse à dessein : réingérer une
 * expédition déjà connue ne coûte rien (tout est idempotent), tandis qu'un
 * webhook perdu pendant quelques heures serait invisible.
 */
export const POLL_LOOKBACK_MINUTES = 6 * 60;

/** Statuts depuis lesquels une commande peut encore partir. */
const SHIPPABLE_FROM = ['PAID', 'PROCESSING', 'PARTIALLY_REFUNDED'] as const;

export interface IngestReport {
  seen: number;
  created: number;
  updated: number;
  ignored: number;
  ordersShipped: number;
}

/**
 * RETOUR D'EXPÉDITION : ShipStation → nous (tâche 13).
 *
 * Dès qu'une étiquette est créée dans ShipStation, nous récupérons le
 * transporteur, le service, le numéro de suivi et le coût, puis :
 *   - une ligne `shipments` est créée (transporteur NORMALISÉ vers notre
 *     enum ; plusieurs colis ⇒ plusieurs lignes) ;
 *   - la commande passe `SHIPPED`, ce qui déclenche le courriel
 *     d'expédition de la tâche 12 (une seule fois, clé d'idempotence).
 *
 * Deux chemins d'entrée, volontairement redondants et strictement
 * idempotents (unicité de `shipments.shipstation_shipment_id`) :
 *   1. le **webhook** ShipStation (immédiat) ;
 *   2. le **polling de repli** (périodique), qui rattrape tout webhook perdu.
 */
@Injectable()
export class ShipstationShipmentsService {
  private readonly logger = new Logger(ShipstationShipmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ShipstationClient,
    private readonly lifecycle: OrderLifecycleService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------- Webhook ------------------------------- */

  /** Suit le `resource_url` du webhook et ingère les expéditions livrées. */
  async ingestFromResourceUrl(resourceUrl: string): Promise<IngestReport> {
    const page = await this.client.fetchWebhookResource(resourceUrl);
    return this.ingestMany(page.shipments);
  }

  /* --------------------------- Polling de repli --------------------------- */

  /**
   * Rattrapage périodique : toutes les expéditions créées dans la fenêtre
   * récente. Sans clés ShipStation, ne fait rien (aucune erreur bruyante).
   */
  async pollRecentShipments(
    lookbackMinutes: number = POLL_LOOKBACK_MINUTES,
  ): Promise<IngestReport> {
    const empty: IngestReport = { seen: 0, created: 0, updated: 0, ignored: 0, ordersShipped: 0 };
    if (!this.client.isConfigured()) return empty;

    const since = new Date(Date.now() - lookbackMinutes * 60_000);
    const report = { ...empty };
    let page = 1;
    let pages = 1;
    do {
      const result = await this.client.listShipmentsSince(since, page);
      const partial = await this.ingestMany(result.shipments);
      report.seen += partial.seen;
      report.created += partial.created;
      report.updated += partial.updated;
      report.ignored += partial.ignored;
      report.ordersShipped += partial.ordersShipped;
      pages = result.pages;
      page += 1;
    } while (page <= pages);

    if (report.created > 0) {
      this.logger.warn(
        `Polling de repli : ${report.created} expédition(s) récupérée(s) qu'aucun webhook n'avait apportée(s).`,
      );
    }
    return report;
  }

  /* ------------------------------ Ingestion ------------------------------ */

  async ingestMany(shipments: readonly ShipstationShipment[]): Promise<IngestReport> {
    const report: IngestReport = { seen: 0, created: 0, updated: 0, ignored: 0, ordersShipped: 0 };
    for (const shipment of shipments) {
      report.seen += 1;
      const outcome = await this.ingestOne(shipment);
      if (outcome === 'ignored') report.ignored += 1;
      else {
        report[outcome.created ? 'created' : 'updated'] += 1;
        if (outcome.orderShipped) report.ordersShipped += 1;
      }
    }
    return report;
  }

  private async ingestOne(
    raw: ShipstationShipment,
  ): Promise<'ignored' | { created: boolean; orderShipped: boolean }> {
    // Une étiquette annulée dans ShipStation n'expédie rien.
    if (raw.voided) {
      this.logger.log(`Expédition ShipStation ${raw.shipmentId} annulée (voided) — ignorée.`);
      return 'ignored';
    }

    const order = await this.resolveOrder(raw);
    if (!order) {
      this.logger.warn(
        `Expédition ShipStation ${raw.shipmentId} sans commande correspondante (${raw.orderNumber}) — ignorée.`,
      );
      return 'ignored';
    }

    const carrier = normalizeCarrierCode(raw.carrierCode);
    const locale = order.locale as Locale;
    const trackingUrl = trackingUrlFor(carrier, raw.trackingNumber, locale);
    const shippedAt = parseDate(raw.shipDate) ?? parseDate(raw.createDate) ?? new Date();

    const data = {
      carrier,
      carrierCode: raw.carrierCode,
      serviceCode: raw.serviceCode,
      trackingNumber: raw.trackingNumber,
      trackingUrl,
      shipstationOrderId: String(raw.orderId),
      costCents: dollarsToCents(raw.shipmentCost),
      weightGrams: toGrams(raw.weight),
      shippedAt,
      ...toCentimeters(raw.dimensions),
    };

    const existing = await this.prisma.shipment.findUnique({
      where: { shipstationShipmentId: String(raw.shipmentId) },
      select: { id: true },
    });

    const shipment = await this.prisma.shipment.upsert({
      where: { shipstationShipmentId: String(raw.shipmentId) },
      update: data,
      create: {
        ...data,
        shipstationShipmentId: String(raw.shipmentId),
        order: { connect: { id: order.id } },
        status: 'CREATED',
      },
    });

    // ARME le suivi (tâche 14) : premier repérage sous peu — sans écraser
    // une planification déjà en cours (réingestion webhook + polling).
    if (
      shipment.trackingNumber &&
      shipment.carrier &&
      shipment.carrier !== 'OTHER' &&
      !shipment.nextPollAt &&
      shipment.status !== 'DELIVERED' &&
      shipment.status !== 'RETURNED'
    ) {
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: { nextPollAt: new Date(Date.now() + TRACKING_FIRST_POLL_DELAY_MS) },
      });
    }

    // À partir d'ici, l'annulation automatique de la commande est bloquée.
    await markShipstationLabelCreated(this.prisma, order.id, shippedAt);

    const orderShipped = await this.ensureShipped(order, {
      carrier: carrierLabel(carrier, locale),
      trackingNumber: raw.trackingNumber,
      trackingUrl,
    });

    if (!existing) {
      await this.audit.log({
        action: 'shipment.created',
        actorType: 'webhook',
        entityType: 'order',
        entityId: order.id,
        metadata: {
          number: order.number,
          shipstationShipmentId: raw.shipmentId,
          carrier,
          carrierCode: raw.carrierCode,
          trackingNumber: raw.trackingNumber,
        },
      });
    }
    return { created: !existing, orderShipped };
  }

  /**
   * Rattache l'expédition à SA commande. `customField1` porte notre UUID :
   * il survit à un renommage de la commande dans ShipStation. Le numéro de
   * commande sert de repli (commande créée à la main par l'équipe).
   */
  private async resolveOrder(raw: ShipstationShipment): Promise<Order | null> {
    const uuid = raw.advancedOptions?.customField1?.trim();
    if (uuid && UUID_RE.test(uuid)) {
      const byId = await this.prisma.order.findUnique({ where: { id: uuid } });
      if (byId) return byId;
    }
    const key = raw.orderKey?.trim() || raw.orderNumber?.trim();
    if (!key) return null;
    return this.prisma.order.findUnique({ where: { number: key } });
  }

  /**
   * Passe la commande à `SHIPPED` (courriel d'expédition). Idempotent : une
   * commande déjà expédiée ou livrée ne rejoue rien, les colis suivants d'un
   * envoi multi-colis n'envoient pas un second courriel.
   */
  private async ensureShipped(
    order: Order,
    notice: { carrier: string; trackingNumber: string | null; trackingUrl: string | null },
  ): Promise<boolean> {
    const fresh = await this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true },
    });
    if (fresh.status === 'SHIPPED' || fresh.status === 'DELIVERED') return false;

    if (!SHIPPABLE_FROM.includes(fresh.status as (typeof SHIPPABLE_FROM)[number])) {
      // CANCELLED / REFUNDED / PENDING : une étiquette existe pourtant. Cas
      // à traiter par un humain — on trace haut et fort, sans rien forcer.
      this.logger.error(
        `Étiquette créée pour la commande ${order.number} au statut « ${fresh.status} » — intervention manuelle requise.`,
      );
      await this.audit.log({
        action: 'shipment.unexpected_status',
        actorType: 'webhook',
        entityType: 'order',
        entityId: order.id,
        metadata: { number: order.number, status: fresh.status },
      });
      return false;
    }

    // PAID : l'étiquette est partie avant que la poussée n'ait marqué la
    // commande « en préparation ». On passe par l'étape manquante.
    if (fresh.status === 'PAID') {
      await this.lifecycle.markProcessing(order.id, { type: 'system' }, 'Étiquette ShipStation');
    }
    await this.lifecycle.markShipped(order.id, { type: 'system' }, notice);
    return true;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // ShipStation renvoie « 2026-07-09T13:24:11.0000000 » (heure du compte, sans zone).
  const date = new Date(value.endsWith('Z') ? value : `${value.replace(/\.\d+$/, '')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dollarsToCents(amount: number | null | undefined): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function toGrams(weight: ShipstationShipment['weight']): number | null {
  if (!weight || !Number.isFinite(weight.value)) return null;
  switch (weight.units) {
    case 'grams':
      return Math.round(weight.value);
    case 'ounces':
      return Math.round(weight.value * 28.349523125);
    case 'pounds':
      return Math.round(weight.value * 453.59237);
    default:
      return null;
  }
}

function toCentimeters(
  dimensions: ShipstationShipment['dimensions'],
): { lengthCm: number; widthCm: number; heightCm: number } | Record<string, never> {
  if (!dimensions) return {};
  const factor = /inch/i.test(dimensions.units) ? 2.54 : 1;
  const round = (value: number): number => Math.round(value * factor * 100) / 100;
  return {
    lengthCm: round(dimensions.length),
    widthCm: round(dimensions.width),
    heightCm: round(dimensions.height),
  };
}
