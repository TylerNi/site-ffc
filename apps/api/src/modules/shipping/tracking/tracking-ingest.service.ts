import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { type Order, type Shipment } from '@prisma/client';
import { isFinalShipmentStatus, type ShipmentStatus } from '@ffc/core';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { type TrackingEvent, type TrackingResult } from './carrier-tracker';
import { TrackingMilestonesService } from './tracking-milestones.service';

/**
 * Rang de PROGRESSION des statuts — uniquement pour départager deux
 * événements scannés à la même seconde (lots de scans) : le plus « avancé »
 * l'emporte. Ce n'est PAS une machine à états : un colis peut légitimement
 * reculer (EXCEPTION → IN_TRANSIT quand il repart).
 */
const STATUS_PROGRESSION: Record<ShipmentStatus, number> = {
  CREATED: 0,
  PICKED_UP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  EXCEPTION: 4,
  RETURNED: 5,
  DELIVERED: 6,
};

export interface IngestOutcome {
  /** Événements réellement insérés (les rejoués sont dédupliqués). */
  createdEvents: number;
  /** Statut du colis après ingestion. */
  status: ShipmentStatus;
  /** Transition effectuée (null si le statut n'a pas bougé). */
  transition: { from: ShipmentStatus; to: ShipmentStatus } | null;
}

/** Colis + commande porteuse (locale, courriel, compte) pour les jalons. */
export type ShipmentWithOrder = Shipment & {
  order: Order & { user: { email: string } | null };
};

/**
 * STOCKAGE du repérage (tâche 14) : la seule porte d'écriture des
 * `shipment_events` et du statut courant des `shipments`.
 *
 *   - **Déduplication stricte** : chaque événement reçoit une clé calculée
 *     (hash code + horodatage + lieu) unique par colis — le polling revoit
 *     sans cesse l'historique complet, il n'insère jamais deux fois la même
 *     ligne.
 *   - **Statut courant** : celui de l'événement cartographié le plus récent
 *     (les codes inconnus, statut null, n'influencent rien). La mise à jour
 *     est conditionnelle au statut lu (aucune course), et un statut FINAL
 *     n'est jamais écrasé.
 *   - **Événement interne** : toute transition est auditée
 *     (`shipment.status_changed`) puis dispatchée aux jalons
 *     (TrackingMilestonesService) — courriel + push, anti-doublon strict.
 */
@Injectable()
export class TrackingIngestService {
  private readonly logger = new Logger(TrackingIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly milestones: TrackingMilestonesService,
    private readonly audit: AuditService,
  ) {}

  /** Applique un résultat de repérage à UN colis. */
  async apply(shipmentId: string, result: TrackingResult & { kind: 'ok' }): Promise<IngestOutcome> {
    const shipment = await this.loadShipment(shipmentId);
    const from = shipment.status;

    const inserted = await this.prisma.shipmentEvent.createMany({
      data: result.events.map((event) => ({
        shipmentId,
        status: event.status,
        code: event.code,
        description: event.description,
        location: event.location,
        occurredAt: event.occurredAt,
        dedupKey: eventDedupKey(event),
      })),
      skipDuplicates: true,
    });

    const derived = deriveStatus(result.events) ?? from;
    // Un statut final ne recule jamais (le poller s'y arrête de toute façon).
    const to = isFinalShipmentStatus(from) ? from : derived;

    const timestamps = {
      ...(result.estimatedDeliveryAt ? { estimatedDeliveryAt: result.estimatedDeliveryAt } : {}),
      ...(to === 'DELIVERED' && !shipment.deliveredAt
        ? { deliveredAt: latestOccurrence(result.events, 'DELIVERED') ?? new Date() }
        : {}),
    };

    if (to === from) {
      if (Object.keys(timestamps).length > 0) {
        await this.prisma.shipment.update({ where: { id: shipmentId }, data: timestamps });
      }
      return { createdEvents: inserted.count, status: to, transition: null };
    }

    // Transition conditionnelle : ne franchit qu'à partir du statut lu.
    const claimed = await this.prisma.shipment.updateMany({
      where: { id: shipmentId, status: from },
      data: { status: to, ...timestamps },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Colis ${shipmentId} : statut modifié pendant l'ingestion — sans effet.`);
      const fresh = await this.prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        select: { status: true },
      });
      return { createdEvents: inserted.count, status: fresh.status, transition: null };
    }

    // ÉVÉNEMENT INTERNE de transition : trace d'audit, puis jalons
    // (courriel + push). Les jalons sont idempotents — un échec ici ne
    // corrompt jamais l'état déjà persisté du colis.
    await this.audit.log({
      action: 'shipment.status_changed',
      actorType: 'system',
      entityType: 'shipment',
      entityId: shipmentId,
      metadata: {
        orderId: shipment.orderId,
        orderNumber: shipment.order.number,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        from,
        to,
      },
    });
    await this.milestones.onTransition(shipment, from, to);

    this.logger.log(
      `Colis ${shipment.trackingNumber ?? shipmentId} (${shipment.carrier ?? '?'}) : ${from} → ${to}` +
        (inserted.count > 0 ? ` (+${inserted.count} événement(s))` : ''),
    );
    return { createdEvents: inserted.count, status: to, transition: { from, to } };
  }

  private async loadShipment(shipmentId: string): Promise<ShipmentWithOrder> {
    return this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: { order: { include: { user: { select: { email: true } } } } },
    });
  }
}

/**
 * Clé de déduplication d'un événement : hash du code source, de
 * l'horodatage et du lieu (voir schema.prisma). Le libellé n'y entre pas —
 * un même scan reformulé par le transporteur reste le même événement.
 */
export function eventDedupKey(
  event: Pick<TrackingEvent, 'code' | 'occurredAt' | 'location'>,
): string {
  return createHash('sha256')
    .update(`${event.code}|${event.occurredAt.toISOString()}|${event.location ?? ''}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Statut courant d'après une chronologie : celui de l'événement CARTOGRAPHIÉ
 * le plus récent. Égalité d'horodatage : le plus avancé l'emporte.
 */
export function deriveStatus(events: readonly TrackingEvent[]): ShipmentStatus | null {
  let best: TrackingEvent | null = null;
  for (const event of events) {
    if (!event.status) continue;
    if (
      !best ||
      event.occurredAt.getTime() > best.occurredAt.getTime() ||
      (event.occurredAt.getTime() === best.occurredAt.getTime() &&
        STATUS_PROGRESSION[event.status] > STATUS_PROGRESSION[best.status!])
    ) {
      best = event;
    }
  }
  return best?.status ?? null;
}

function latestOccurrence(events: readonly TrackingEvent[], status: ShipmentStatus): Date | null {
  let latest: Date | null = null;
  for (const event of events) {
    if (event.status !== status) continue;
    if (!latest || event.occurredAt.getTime() > latest.getTime()) latest = event.occurredAt;
  }
  return latest;
}
