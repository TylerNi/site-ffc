import { type Carrier, type ShipmentStatus } from '@ffc/core';

/**
 * Interface COMMUNE des adapters de repérage (tâche 14).
 *
 * Entrée : un numéro de suivi. Sortie : un résultat normalisé — statuts de
 * l'enum `ShipmentStatus` (tâche 04), événements horodatés (code source du
 * transporteur, libellé, lieu) et date de livraison estimée si le
 * transporteur la fournit. TOUTES les particularités (authentification,
 * format XML/JSON/SOAP, codes maison, fuseaux) restent enfermées dans
 * l'adapter ; le poller, l'ingestion et la page « Mes colis » ne voient que
 * ces types.
 */

/** Événement de repérage normalisé (une ligne de la chronologie). */
export interface TrackingEvent {
  /** Code source du transporteur, TEL QUEL (« 1496 », « DEL », « OnDelivery »…). */
  code: string;
  /** Statut normalisé déduit du code — null si le code n'est pas cartographié. */
  status: ShipmentStatus | null;
  /** Libellé source du transporteur (langue du transporteur). */
  description: string | null;
  /** Lieu tel que fourni (« MONTRÉAL, QC »…). */
  location: string | null;
  occurredAt: Date;
}

/**
 * Résultat d'un appel de repérage.
 *
 * `not_found` n'est PAS une erreur : un numéro fraîchement émis est inconnu
 * du transporteur pendant les premières heures (l'étiquette existe, le colis
 * n'est pas encore scanné). Le poller réessaie plus tard sans bruit.
 */
export type TrackingResult =
  | {
      readonly kind: 'ok';
      /** Chronologie complète connue du transporteur (ordre quelconque). */
      readonly events: readonly TrackingEvent[];
      /** Date de livraison estimée, si le transporteur la publie. */
      readonly estimatedDeliveryAt: Date | null;
    }
  | { readonly kind: 'not_found' };

export const TRACKING_NOT_FOUND: TrackingResult = { kind: 'not_found' };

/** Un adapter par transporteur, derrière cette seule interface. */
export interface CarrierTracker {
  readonly carrier: Carrier;
  /** false = accès API absent (tâche 01) : le poller reporte sans compter d'échec. */
  isConfigured(): boolean;
  track(trackingNumber: string): Promise<TrackingResult>;
}

/**
 * Jeton d'injection de la liste des adapters. Le poller les découvre par
 * `carrier` — ajouter un transporteur = ajouter un adapter à cette liste.
 */
export const CARRIER_TRACKERS = Symbol('CARRIER_TRACKERS');

/**
 * Erreur de repérage. `retryable` sépare ce qui mérite une retentative
 * rapprochée (réseau, 429, 5xx) de ce qui est définitif (authentification
 * refusée, requête invalide) et attend une intervention.
 */
export class CarrierTrackingError extends Error {
  constructor(
    message: string,
    readonly carrier: Carrier,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CarrierTrackingError';
  }
}
