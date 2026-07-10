import { Injectable, Logger } from '@nestjs/common';
import { type Carrier } from '@ffc/core';

/** Échecs CONSÉCUTIFS d'un adapter avant l'alerte « échoue en série ». */
export const TRACKING_ALERT_THRESHOLD = 5;

export interface CarrierMetricsSnapshot {
  carrier: Carrier;
  /** Appels de repérage depuis le démarrage du processus. */
  polls: number;
  ok: number;
  notFound: number;
  failures: number;
  consecutiveFailures: number;
  /** Alerte active : l'adapter échoue en série (seuil atteint). */
  alertActive: boolean;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

interface CarrierCounters {
  polls: number;
  ok: number;
  notFound: number;
  failures: number;
  consecutiveFailures: number;
  alertActive: boolean;
  lastLatencyMs: number | null;
  latencyTotalMs: number;
  latencySamples: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

/**
 * Métriques de repérage PAR TRANSPORTEUR (tâche 14) — compteurs mémoire du
 * processus (worker) : colis interrogés, erreurs, latence.
 *
 * L'ALERTE « un adapter échoue en série » est un log `error` émis UNE fois
 * par série au franchissement du seuil (les alarmes CloudWatch s'accrochent
 * aux logs d'erreur) ; elle reste levée dans `/v1/admin/tracking` jusqu'au
 * premier succès. Les états durables (statuts, colis bloqués) viennent de
 * la base — voir TrackingAdminService.
 */
@Injectable()
export class TrackingMetricsService {
  private readonly logger = new Logger(TrackingMetricsService.name);
  private readonly counters = new Map<Carrier, CarrierCounters>();

  recordSuccess(carrier: Carrier, latencyMs: number, kind: 'ok' | 'not_found'): void {
    const counter = this.counterFor(carrier);
    counter.polls += 1;
    counter[kind === 'ok' ? 'ok' : 'notFound'] += 1;
    counter.lastLatencyMs = latencyMs;
    counter.latencyTotalMs += latencyMs;
    counter.latencySamples += 1;
    counter.lastSuccessAt = new Date();
    if (counter.alertActive) {
      this.logger.log(`Adapter ${carrier} rétabli après ${counter.consecutiveFailures} échec(s).`);
    }
    counter.consecutiveFailures = 0;
    counter.alertActive = false;
  }

  recordFailure(carrier: Carrier, message: string): void {
    const counter = this.counterFor(carrier);
    counter.polls += 1;
    counter.failures += 1;
    counter.consecutiveFailures += 1;
    counter.lastError = message.slice(0, 500);
    counter.lastErrorAt = new Date();
    if (counter.consecutiveFailures === TRACKING_ALERT_THRESHOLD) {
      counter.alertActive = true;
      this.logger.error(
        `ALERTE repérage : l'adapter ${carrier} échoue en série ` +
          `(${counter.consecutiveFailures} échecs consécutifs) — dernier : ${counter.lastError}`,
      );
    }
  }

  snapshot(): CarrierMetricsSnapshot[] {
    return [...this.counters.entries()].map(([carrier, counter]) => ({
      carrier,
      polls: counter.polls,
      ok: counter.ok,
      notFound: counter.notFound,
      failures: counter.failures,
      consecutiveFailures: counter.consecutiveFailures,
      alertActive: counter.alertActive,
      lastLatencyMs: counter.lastLatencyMs,
      avgLatencyMs:
        counter.latencySamples > 0
          ? Math.round(counter.latencyTotalMs / counter.latencySamples)
          : null,
      lastSuccessAt: counter.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: counter.lastErrorAt?.toISOString() ?? null,
      lastError: counter.lastError,
    }));
  }

  snapshotFor(carrier: Carrier): CarrierMetricsSnapshot | null {
    return this.snapshot().find((entry) => entry.carrier === carrier) ?? null;
  }

  private counterFor(carrier: Carrier): CarrierCounters {
    let counter = this.counters.get(carrier);
    if (!counter) {
      counter = {
        polls: 0,
        ok: 0,
        notFound: 0,
        failures: 0,
        consecutiveFailures: 0,
        alertActive: false,
        lastLatencyMs: null,
        latencyTotalMs: 0,
        latencySamples: 0,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
      };
      this.counters.set(carrier, counter);
    }
    return counter;
  }
}
