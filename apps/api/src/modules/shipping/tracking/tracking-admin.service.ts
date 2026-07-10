import { Injectable } from '@nestjs/common';
import { type Carrier, type ShipmentStatus } from '@ffc/core';
import { PrismaService } from '../../../database';
import { type CarrierMetricsSnapshot, TrackingMetricsService } from './tracking-metrics.service';
import { TrackingPollerService } from './tracking-poller.service';

/** Ancienneté (jours) au-delà de laquelle un colis actif est « bloqué ». */
export const DEFAULT_STALE_DAYS = 5;

/** Borne le balayage des colis actifs (l'actif est petit, la borne rassure). */
const ACTIVE_SCAN_LIMIT = 1_000;

export interface CarrierOverview {
  carrier: Carrier;
  /** Clés d'accès configurées (adapter opérationnel). */
  configured: boolean;
  /** Colis actifs (ni livrés ni retournés) portant un numéro. */
  active: number;
  /** Colis actifs par statut. */
  byStatus: Partial<Record<ShipmentStatus, number>>;
  /** Colis actifs sans mise à jour depuis N jours. */
  stale: number;
  /** Compteurs du worker (depuis son démarrage) — null : jamais pollé ici. */
  metrics: CarrierMetricsSnapshot | null;
}

export interface StaleShipmentRow {
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  carrier: Carrier | null;
  trackingNumber: string | null;
  status: ShipmentStatus;
  /** Dernier événement transporteur (repli : date d'expédition/création). */
  lastMovementAt: string;
  daysWithoutUpdate: number;
  nextPollAt: string | null;
  pollFailures: number;
}

export interface TrackingOverview {
  staleDays: number;
  carriers: CarrierOverview[];
  staleShipments: StaleShipmentRow[];
}

/**
 * OBSERVABILITÉ du suivi (tâche 14), consommée par `/v1/admin/tracking` :
 * état durable depuis la base (colis actifs par transporteur et statut,
 * colis « bloqués » sans mise à jour depuis N jours) fusionné avec les
 * compteurs mémoire du worker (latence, erreurs, alerte d'échecs en série).
 */
@Injectable()
export class TrackingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: TrackingMetricsService,
    private readonly poller: TrackingPollerService,
  ) {}

  async overview(staleDays: number = DEFAULT_STALE_DAYS): Promise<TrackingOverview> {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        status: { notIn: ['DELIVERED', 'RETURNED'] },
        trackingNumber: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      take: ACTIVE_SCAN_LIMIT,
      include: {
        order: { select: { id: true, number: true } },
        events: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
      },
    });

    const now = Date.now();
    const staleBefore = now - staleDays * 24 * 3_600_000;

    const perCarrier = new Map<Carrier, CarrierOverview>();
    for (const carrier of this.poller.supportedCarriers) {
      perCarrier.set(carrier, {
        carrier,
        configured: this.poller.isConfigured(carrier),
        active: 0,
        byStatus: {},
        stale: 0,
        metrics: this.metrics.snapshotFor(carrier),
      });
    }

    const staleShipments: StaleShipmentRow[] = [];
    for (const shipment of shipments) {
      const carrier = shipment.carrier;
      const overview = carrier ? perCarrier.get(carrier) : undefined;
      if (overview) {
        overview.active += 1;
        overview.byStatus[shipment.status] = (overview.byStatus[shipment.status] ?? 0) + 1;
      }

      const lastMovement =
        shipment.events[0]?.occurredAt ?? shipment.shippedAt ?? shipment.createdAt;
      if (lastMovement.getTime() < staleBefore) {
        if (overview) overview.stale += 1;
        staleShipments.push({
          shipmentId: shipment.id,
          orderId: shipment.order.id,
          orderNumber: shipment.order.number,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          status: shipment.status,
          lastMovementAt: lastMovement.toISOString(),
          daysWithoutUpdate: Math.floor((now - lastMovement.getTime()) / (24 * 3_600_000)),
          nextPollAt: shipment.nextPollAt?.toISOString() ?? null,
          pollFailures: shipment.pollFailures,
        });
      }
    }

    // Les plus anciens d'abord : ce sont eux qui inquiètent.
    staleShipments.sort((a, b) => b.daysWithoutUpdate - a.daysWithoutUpdate);

    return {
      staleDays,
      carriers: [...perCarrier.values()],
      staleShipments: staleShipments.slice(0, 50),
    };
  }
}
