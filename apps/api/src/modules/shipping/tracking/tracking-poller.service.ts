import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Carrier, isFinalShipmentStatus, type ShipmentStatus } from '@ffc/core';
import { type Shipment } from '@prisma/client';
import { PrismaService } from '../../../database';
import { CARRIER_TRACKERS, type CarrierTracker, CarrierTrackingError } from './carrier-tracker';
import { TrackingIngestService } from './tracking-ingest.service';
import { TrackingMetricsService } from './tracking-metrics.service';

/* ------------------------- Cadences de polling ------------------------- */
// Aucun des transporteurs ne pousse de mise à jour : TOUT repose sur ce
// polling. Les cadences arbitrent fraîcheur contre quotas d'API.

/** Cadence par défaut (colis créé, pris en charge, en transit). */
export const TRACKING_DEFAULT_INTERVAL_MS = 6 * 3_600_000;
/** Colis « en livraison » : le statut peut basculer d'heure en heure. */
export const TRACKING_OUT_FOR_DELIVERY_INTERVAL_MS = 3_600_000;
/** Exception : poursuite PRUDENTE — le colis peut repartir, sans urgence. */
export const TRACKING_EXCEPTION_INTERVAL_MS = 12 * 3_600_000;
/** Numéro encore inconnu du transporteur (normal les premières heures). */
export const TRACKING_NOT_FOUND_INTERVAL_MS = 3_600_000;
/** Premier repérage après la création de l'étiquette (tâche 13). */
export const TRACKING_FIRST_POLL_DELAY_MS = 15 * 60_000;
/** Adapter non configuré (clés absentes, tâche 01) : on repasse plus tard. */
export const TRACKING_UNCONFIGURED_INTERVAL_MS = 6 * 3_600_000;
/** Erreur DÉFINITIVE (auth refusée, requête invalide) : ne pas marteler. */
export const TRACKING_PERMANENT_ERROR_INTERVAL_MS = 24 * 3_600_000;

/** Recul exponentiel des erreurs retentables : 15 min, 30 min, 1 h… ≤ 6 h. */
export const TRACKING_RETRY_BASE_MS = 15 * 60_000;
export const TRACKING_RETRY_MAX_MS = 6 * 3_600_000;

/**
 * Bail de traitement : le scan repousse `next_poll_at` AVANT l'appel réseau
 * — une seconde instance ne reprend pas le même colis, et un processus tué
 * laisse le colis retentable après le bail (reprise propre au redémarrage).
 */
export const TRACKING_LEASE_MS = 10 * 60_000;

/** Colis traités par passage de scan (borne la durée d'un job). */
const SCAN_BATCH_SIZE = 100;

export function trackingBackoffMs(consecutiveFailures: number): number {
  const delay = TRACKING_RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(delay, TRACKING_RETRY_MAX_MS);
}

/** Cadence adaptée au statut courant — null : arrêt définitif du polling. */
export function pollIntervalFor(status: ShipmentStatus): number | null {
  if (isFinalShipmentStatus(status)) return null;
  switch (status) {
    case 'OUT_FOR_DELIVERY':
      return TRACKING_OUT_FOR_DELIVERY_INTERVAL_MS;
    case 'EXCEPTION':
      return TRACKING_EXCEPTION_INTERVAL_MS;
    default:
      return TRACKING_DEFAULT_INTERVAL_MS;
  }
}

export interface ScanReport {
  claimed: number;
  ok: number;
  notFound: number;
  failed: number;
  unconfigured: number;
  transitions: number;
}

/**
 * WORKER de polling adaptatif (tâche 14) — consomme la file `shipments`
 * (index `[status, next_poll_at]`).
 *
 *   - **Planification adaptative** : 6 h par défaut, 1 h en livraison,
 *     12 h en exception, arrêt définitif à livré/retourné.
 *   - **Isolation des pannes** : les colis dus sont regroupés PAR
 *     transporteur ; chaque groupe avance dans sa propre promesse
 *     (`Promise.allSettled`) et chaque colis encaisse ses erreurs — un
 *     Purolator en panne ne ralentit ni ne bloque Postes Canada, Nationex
 *     ou Canpar (le throttling est lui aussi par transporteur, voir
 *     TrackingHttp).
 *   - **Retries** : recul exponentiel PAR COLIS (`poll_failures`), remis à
 *     zéro au premier succès — la reprise après panne ne perd rien puisque
 *     chaque repérage relit l'historique complet (dédupliqué à l'ingestion).
 *   - **Reprise au redémarrage** : tout l'état (dû, bail, échecs) vit en
 *     base ; le job répétable est réenregistré au démarrage du worker.
 */
@Injectable()
export class TrackingPollerService {
  private readonly logger = new Logger(TrackingPollerService.name);
  private readonly trackers: ReadonlyMap<Carrier, CarrierTracker>;
  /** Transporteurs sans clés déjà signalés (un log par processus, pas par scan). */
  private readonly warnedUnconfigured = new Set<Carrier>();
  /** Un seul scan à la fois dans ce processus. */
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CARRIER_TRACKERS) trackers: CarrierTracker[],
    private readonly ingest: TrackingIngestService,
    private readonly metrics: TrackingMetricsService,
  ) {
    this.trackers = new Map(trackers.map((tracker) => [tracker.carrier, tracker]));
  }

  /** Transporteurs disposant d'un adapter (seuls eux sont pollés). */
  get supportedCarriers(): Carrier[] {
    return [...this.trackers.keys()];
  }

  isConfigured(carrier: Carrier): boolean {
    return this.trackers.get(carrier)?.isConfigured() ?? false;
  }

  /** Un passage de scan : réclame les colis dus et les repère. */
  async scan(now: Date = new Date()): Promise<ScanReport> {
    const report: ScanReport = {
      claimed: 0,
      ok: 0,
      notFound: 0,
      failed: 0,
      unconfigured: 0,
      transitions: 0,
    };
    if (this.scanning) return report;

    this.scanning = true;
    try {
      const due = await this.prisma.shipment.findMany({
        where: {
          nextPollAt: { lte: now },
          trackingNumber: { not: null },
          carrier: { in: this.supportedCarriers },
          status: { notIn: ['DELIVERED', 'RETURNED'] },
        },
        orderBy: { nextPollAt: 'asc' },
        take: SCAN_BATCH_SIZE,
      });

      const claimed: Shipment[] = [];
      for (const shipment of due) {
        if (await this.claim(shipment)) claimed.push(shipment);
      }
      report.claimed = claimed.length;

      const byCarrier = new Map<Carrier, Shipment[]>();
      for (const shipment of claimed) {
        const carrier = shipment.carrier as Carrier;
        const group = byCarrier.get(carrier) ?? [];
        group.push(shipment);
        byCarrier.set(carrier, group);
      }

      // ISOLATION : un groupe (transporteur) par promesse — les groupes
      // avancent indépendamment, un échec n'affecte que le sien.
      await Promise.allSettled(
        [...byCarrier.entries()].map(async ([carrier, group]) => {
          const tracker = this.trackers.get(carrier)!;
          for (const shipment of group) {
            const outcome = await this.pollOne(tracker, shipment);
            report[outcome.kind] += 1;
            if (outcome.transitioned) report.transitions += 1;
          }
        }),
      );
    } finally {
      this.scanning = false;
    }

    if (report.claimed > 0) {
      this.logger.log(
        `Scan de repérage : ${report.claimed} colis — ${report.ok} ok, ` +
          `${report.notFound} inconnus, ${report.failed} échecs, ${report.transitions} transition(s).`,
      );
    }
    return report;
  }

  /* ------------------------------- Interne ------------------------------- */

  /** Bail optimiste (voir TRACKING_LEASE_MS). */
  private async claim(shipment: Shipment): Promise<boolean> {
    const claimed = await this.prisma.shipment.updateMany({
      where: { id: shipment.id, nextPollAt: shipment.nextPollAt },
      data: { nextPollAt: new Date(Date.now() + TRACKING_LEASE_MS) },
    });
    return claimed.count > 0;
  }

  /** Repère UN colis — n'échappe JAMAIS d'erreur (isolation). */
  private async pollOne(
    tracker: CarrierTracker,
    shipment: Shipment,
  ): Promise<{ kind: 'ok' | 'notFound' | 'failed' | 'unconfigured'; transitioned: boolean }> {
    const carrier = tracker.carrier;

    if (!tracker.isConfigured()) {
      if (!this.warnedUnconfigured.has(carrier)) {
        this.warnedUnconfigured.add(carrier);
        this.logger.warn(
          `Adapter ${carrier} sans accès API (tâche 01) — repérage reporté, lien public seulement.`,
        );
      }
      await this.reschedule(shipment.id, TRACKING_UNCONFIGURED_INTERVAL_MS, null);
      return { kind: 'unconfigured', transitioned: false };
    }

    const startedAt = Date.now();
    try {
      const result = await tracker.track(shipment.trackingNumber!);
      const latency = Date.now() - startedAt;

      if (result.kind === 'not_found') {
        this.metrics.recordSuccess(carrier, latency, 'not_found');
        await this.reschedule(shipment.id, TRACKING_NOT_FOUND_INTERVAL_MS, 0);
        return { kind: 'notFound', transitioned: false };
      }

      const outcome = await this.ingest.apply(shipment.id, result);
      this.metrics.recordSuccess(carrier, latency, 'ok');
      await this.reschedule(shipment.id, pollIntervalFor(outcome.status), 0);
      return { kind: 'ok', transitioned: outcome.transition !== null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics.recordFailure(carrier, message);

      const retryable = error instanceof CarrierTrackingError ? error.retryable : true;
      const failures = shipment.pollFailures + 1;
      const delay = retryable ? trackingBackoffMs(failures) : TRACKING_PERMANENT_ERROR_INTERVAL_MS;
      await this.reschedule(shipment.id, delay, failures);

      this.logger.warn(
        `Repérage ${carrier} ${shipment.trackingNumber} en échec (${failures} consécutif(s), ` +
          `${retryable ? 'retentable' : 'définitif'}) : ${message}`,
      );
      return { kind: 'failed', transitioned: false };
    }
  }

  /**
   * Replanifie le colis. `delayMs` null : arrêt DÉFINITIF (statut final).
   * `failures` null : conserve le compteur (adapter non configuré — ce
   * n'est pas un échec du colis).
   */
  private async reschedule(
    shipmentId: string,
    delayMs: number | null,
    failures: number | null,
  ): Promise<void> {
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        lastPolledAt: new Date(),
        nextPollAt: delayMs === null ? null : new Date(Date.now() + delayMs),
        ...(failures === null ? {} : { pollFailures: failures }),
      },
    });
  }
}
