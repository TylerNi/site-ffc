import { type ShipmentStatus } from '@ffc/core';

/**
 * Purolator — table de correspondance des `ScanType` du service SOAP
 * *TrackingService* (opération `TrackPackagesByPin`) vers nos statuts
 * normalisés (tâche 04).
 *
 * SOURCE : documentation Purolator E-Ship Web Services et corpus de
 * réponses réelles anonymisées (test/fixtures/tracking/purolator/).
 * L'accès API Purolator dépend de la checklist tâche 01 : sans clés,
 * l'adapter se déclare non configuré et le colis garde son lien de
 * repérage public (tâche 13). `ScanType` inconnu → événement conservé
 * avec statut null.
 */
export const PUROLATOR_SCAN_STATUSES: Record<string, ShipmentStatus> = {
  /** Preuve de ramassage chez l'expéditeur. */
  ProofOfPickUp: 'PICKED_UP',

  /** Passage dans un centre de tri Purolator. */
  Depot: 'IN_TRANSIT',

  /** Dans le véhicule de livraison. */
  OnDelivery: 'OUT_FOR_DELIVERY',

  /** Livré (preuve de livraison). */
  Delivery: 'DELIVERED',

  /** Non livrable (absent, adresse erronée, refus) — intervention requise. */
  Undeliverable: 'EXCEPTION',

  /** Retour à l'expéditeur. */
  ReturnToSender: 'RETURNED',

  // « Other » et les scans informatifs restent volontairement absents :
  // ils n'apportent aucun changement d'état (statut null).
};

export function purolatorStatusFor(scanType: string): ShipmentStatus | null {
  return PUROLATOR_SCAN_STATUSES[scanType.trim()] ?? null;
}
