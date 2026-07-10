import { type ShipmentStatus } from '@ffc/core';

/**
 * Canpar — table de correspondance des codes d'événement du service web
 * de repérage (`trackByBarcodeV2`, champ `code` des `events`) vers nos
 * statuts normalisés (tâche 04).
 *
 * SOURCE : documentation CanShip WS et corpus de réponses réelles
 * anonymisées (test/fixtures/tracking/canpar/). Canpar emploie des codes
 * courts de trois lettres ; un code inconnu est conservé dans la
 * chronologie avec un statut null (n'influence pas le statut courant).
 */
export const CANPAR_EVENT_STATUSES: Record<string, ShipmentStatus> = {
  /** Manifeste transmis — l'étiquette existe, le colis n'est pas encore pris. */
  MAN: 'CREATED',

  /** Ramassage chez l'expéditeur. */
  PIC: 'PICKED_UP',

  /** Arrivée à un terminal. */
  ARR: 'IN_TRANSIT',
  /** Départ d'un terminal. */
  DEP: 'IN_TRANSIT',

  /** Dans le véhicule de livraison (« out for delivery »). */
  OFD: 'OUT_FOR_DELIVERY',

  /** Livré. */
  DEL: 'DELIVERED',

  /** Tentative de livraison infructueuse (absent, accès impossible). */
  ATT: 'EXCEPTION',
  /** Exception générique (adresse erronée, colis retenu…). */
  XCP: 'EXCEPTION',

  /** Retour à l'expéditeur. */
  RTS: 'RETURNED',
};

export function canparStatusFor(code: string): ShipmentStatus | null {
  return CANPAR_EVENT_STATUSES[code.trim().toUpperCase()] ?? null;
}
