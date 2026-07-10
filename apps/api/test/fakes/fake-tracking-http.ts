import { type Carrier } from '@ffc/core';
import { CarrierTrackingError } from '../../src/modules/shipping/tracking/carrier-tracker';
import {
  type TrackingHttpRequest,
  type TrackingHttpResponse,
} from '../../src/modules/shipping/tracking/tracking-http';

/**
 * Faux TrackingHttp — même surface que le vrai (la SEULE porte réseau des
 * adapters). Les adapters réels (authentification, URL, parsing, tables de
 * correspondance) sont exercés tels quels : seul le fil réseau est remplacé
 * par des fixtures.
 *
 * Pannes PAR TRANSPORTEUR : `failNetwork` simule une panne persistante
 * (délai/refus de connexion — retentable) jusqu'à `heal`, exactement le
 * scénario « Purolator en panne pendant 1 h » du critère d'acceptation.
 */
export class FakeTrackingHttp {
  private readonly responses = new Map<Carrier, TrackingHttpResponse>();
  private readonly networkDown = new Set<Carrier>();

  /** Journal des appels (assertions d'isolation et de throttling). */
  readonly calls: TrackingHttpRequest[] = [];

  /** La prochaine réponse du transporteur (persiste jusqu'au prochain stage). */
  stage(carrier: Carrier, body: string, status = 200): void {
    this.responses.set(carrier, { status, body });
  }

  /** Panne réseau persistante du transporteur (retentable). */
  failNetwork(carrier: Carrier): void {
    this.networkDown.add(carrier);
  }

  /** Fin de la panne. */
  heal(carrier: Carrier): void {
    this.networkDown.delete(carrier);
  }

  callsFor(carrier: Carrier): TrackingHttpRequest[] {
    return this.calls.filter((call) => call.carrier === carrier);
  }

  async request(req: TrackingHttpRequest): Promise<TrackingHttpResponse> {
    this.calls.push(req);
    if (this.networkDown.has(req.carrier)) {
      // Même contrat que le vrai TrackingHttp sur une panne réseau.
      throw new CarrierTrackingError(
        `ECONNRESET (${req.carrier} ${req.method} ${req.url})`,
        req.carrier,
        null,
        true,
      );
    }
    const staged = this.responses.get(req.carrier);
    if (!staged) {
      throw new Error(
        `FakeTrackingHttp : aucune réponse préparée pour ${req.carrier} — appelez stage() d'abord.`,
      );
    }
    return staged;
  }
}
