import { Injectable, Logger } from '@nestjs/common';
import { type Carrier } from '@ffc/core';
import { CarrierTrackingError } from './carrier-tracker';

/** Délai d'attente réseau d'un appel de repérage. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Limites de débit PAR TRANSPORTEUR (appels/minute), volontairement
 * prudentes : le repérage est un travail de fond, jamais urgent au point de
 * risquer un bannissement de compte. Ajustables quand les contrats réels
 * (tâche 01) préciseront les quotas.
 */
const RATE_LIMIT_PER_MINUTE: Partial<Record<Carrier, number>> = {
  CANADA_POST: 30,
  NATIONEX: 30,
  CANPAR: 30,
  PUROLATOR: 20,
};

export interface TrackingHttpRequest {
  carrier: Carrier;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TrackingHttpResponse {
  status: number;
  body: string;
}

/**
 * Porte HTTP unique des adapters de repérage.
 *
 * Deux responsabilités, et rien d'autre :
 *   1. **Throttling par transporteur** : les appels d'un même transporteur
 *      sont sérialisés et espacés d'un intervalle minimal — chaque
 *      transporteur a SA file, une panne ou un quota chez l'un ne retient
 *      jamais les autres ;
 *   2. **Classification des erreurs réseau** : délai/refus de connexion →
 *      `CarrierTrackingError` retentable. Les statuts HTTP sont rendus tels
 *      quels — leur interprétation (404 = numéro inconnu chez X, corps
 *      d'erreur SOAP chez Y…) appartient à chaque adapter.
 *
 * Les tests substituent ce provider par un faux servant des fixtures : les
 * adapters réels (auth, URL, parsing, tables de correspondance) sont alors
 * exercés sans réseau.
 */
@Injectable()
export class TrackingHttp {
  private readonly logger = new Logger(TrackingHttp.name);
  private readonly gates = new Map<Carrier, RateGate>();

  async request(req: TrackingHttpRequest): Promise<TrackingHttpResponse> {
    await this.gateFor(req.carrier).wait();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.status === 429) {
        // Quota atteint : on retient le PROCHAIN appel de ce transporteur.
        this.gateFor(req.carrier).pushBack(60_000);
        this.logger.warn(`Quota ${req.carrier} atteint (429) — appels espacés.`);
      }
      return { status: response.status, body };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CarrierTrackingError(
        `Appel ${req.carrier} ${req.method} ${req.url} : ${message}`,
        req.carrier,
        null,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private gateFor(carrier: Carrier): RateGate {
    let gate = this.gates.get(carrier);
    if (!gate) {
      gate = new RateGate(Math.ceil(60_000 / (RATE_LIMIT_PER_MINUTE[carrier] ?? 30)));
      this.gates.set(carrier, gate);
    }
    return gate;
  }
}

/** Sérialise les appels d'UN transporteur et les espace d'un intervalle minimal. */
class RateGate {
  private chain: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** Résout quand c'est notre tour — jamais rejetée (c'est une horloge). */
  wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const delay = this.nextAllowedAt - Date.now();
      if (delay > 0) await sleep(delay);
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
    });
    this.chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** Repousse le prochain appel (429 / Retry-After). */
  pushBack(delayMs: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
