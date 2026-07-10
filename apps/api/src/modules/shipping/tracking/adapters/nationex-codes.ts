import { type ShipmentStatus } from '@ffc/core';

/**
 * Nationex — table de correspondance des codes de statut du repérage
 * (champ `status` des entrées `trackingHistories`, API REST v4) vers nos
 * statuts normalisés (tâche 04).
 *
 * SOURCE : documentation de l'API v4 (api.nationex.com) et corpus de
 * réponses réelles anonymisées (test/fixtures/tracking/nationex/). Nationex
 * décrit ses jalons en français (« Ramassage effectué », « En livraison »…) ;
 * les codes courts ci-dessous sont ceux du champ `status`. Code inconnu →
 * événement conservé avec statut null (n'influence pas le statut courant).
 */
export const NATIONEX_STATUS_MAP: Record<string, ShipmentStatus> = {
  /** Envoi enregistré — Nationex connaît l'étiquette, colis pas encore pris. */
  RE: 'CREATED',

  /** Ramassage effectué chez l'expéditeur. */
  RA: 'PICKED_UP',

  /** En transit entre terminaux (départ/arrivée confondus). */
  TR: 'IN_TRANSIT',
  /** Arrivé au terminal de destination — toujours du transit pour le client. */
  AT: 'IN_TRANSIT',

  /** En livraison (dans le véhicule). */
  LI: 'OUT_FOR_DELIVERY',

  /** Livré. */
  LV: 'DELIVERED',

  /** Exception (adresse introuvable, absent, reporté…). */
  EX: 'EXCEPTION',

  /** Retour à l'expéditeur. */
  RT: 'RETURNED',
};

export function nationexStatusFor(code: string): ShipmentStatus | null {
  return NATIONEX_STATUS_MAP[code.trim().toUpperCase()] ?? null;
}
