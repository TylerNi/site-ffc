import { type ShipmentStatus } from '@ffc/core';

/**
 * Postes Canada — table de correspondance des « significant events »
 * (champ `event-identifier` du service *Get Tracking Details*, XML v2)
 * vers nos statuts normalisés (tâche 04).
 *
 * SOURCE : documentation du programme développeur de Postes Canada et corpus
 * de réponses réelles anonymisées (test/fixtures/tracking/canada-post/).
 * Un code ABSENT de la table n'est jamais une erreur : l'événement est
 * conservé dans la chronologie avec un statut null (il n'influence pas le
 * statut courant du colis). La table s'enrichit au fil des codes observés
 * en production — c'est voulu, et c'est ici (et seulement ici) qu'on ajoute.
 *
 * Repères de l'échelle : un même colis passe typiquement par
 * 3000 → 0100 → 0174 → 1496.
 */
export const CANADA_POST_EVENT_STATUSES: Record<string, ShipmentStatus> = {
  /** Ramassage effectué par Postes Canada (induction chez l'expéditeur). */
  '3000': 'PICKED_UP',
  /** Article accepté au comptoir d'un bureau de poste. */
  '1408': 'PICKED_UP',

  /** Article traité dans un établissement postal (tri). */
  '0100': 'IN_TRANSIT',
  /** Article retenu à l'international / examen douanier (colis US) — le
   *  colis progresse toujours : ce n'est pas une exception de livraison. */
  '0173': 'IN_TRANSIT',

  /** Article en cours de livraison (dans le véhicule du facteur). */
  '0174': 'OUT_FOR_DELIVERY',

  /** Article livré (« Item successfully delivered »). */
  '1496': 'DELIVERED',

  /** Tentative de livraison — avis de passage laissé (retrait au comptoir).
   *  Le destinataire doit agir : c'est notre « exception ». */
  '1415': 'EXCEPTION',

  /** Article retourné à l'expéditeur. */
  '1703': 'RETURNED',
};

export function canadaPostStatusFor(eventIdentifier: string): ShipmentStatus | null {
  return CANADA_POST_EVENT_STATUSES[eventIdentifier.trim()] ?? null;
}

/**
 * Codes des messages d'erreur « métier » de Postes Canada signifiant
 * « numéro inconnu » — normal dans les premières heures d'une étiquette
 * (l'article n'a pas encore été scanné). Réponse HTTP 404 + <messages>.
 */
export const CANADA_POST_NOT_FOUND_CODES = new Set(['004', '016']);
