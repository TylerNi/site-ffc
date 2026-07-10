import { type Carrier, type ShipmentStatus } from './enums';
import { type Locale, type LocalizedText } from './locales';

/**
 * Transporteurs : libellés, normalisation des codes ShipStation et liens de
 * repérage — source de vérité PARTAGÉE (API, courriels, admin, web, mobile).
 *
 * Les étiquettes sont créées dans ShipStation par l'équipe d'expédition, qui
 * y compare les tarifs des quatre transporteurs. ShipStation nous renvoie un
 * `carrierCode` textuel (« canada_post », « purolator »…) : nous le ramenons
 * toujours à l'enum `Carrier` avant de le persister, pour que le reste de la
 * plateforme (suivi, courriels, rapports) ne raisonne que sur nos valeurs.
 */

/** Libellés bilingues des transporteurs (courriels, admin, page « Mes colis »). */
export const CARRIER_LABELS: Record<Carrier, LocalizedText> = {
  CANADA_POST: { fr: 'Postes Canada', en: 'Canada Post' },
  NATIONEX: { fr: 'Nationex', en: 'Nationex' },
  CANPAR: { fr: 'Canpar', en: 'Canpar' },
  PUROLATOR: { fr: 'Purolator', en: 'Purolator' },
  OTHER: { fr: 'Autre transporteur', en: 'Other carrier' },
};

export function carrierLabel(carrier: Carrier, locale: Locale): string {
  return CARRIER_LABELS[carrier][locale];
}

/**
 * Codes ShipStation connus → notre enum. La clé est le code APLATI
 * (minuscules, sans séparateur) : « Canada Post », « canada_post » et
 * « canadapost » tombent tous sur la même entrée.
 */
const CARRIER_BY_FLAT_CODE: Record<string, Carrier> = {
  canadapost: 'CANADA_POST',
  postescanada: 'CANADA_POST',
  nationex: 'NATIONEX',
  canpar: 'CANPAR',
  purolator: 'PUROLATOR',
  purolatorinternational: 'PUROLATOR',
};

function flatten(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalise un code (ou un nom) de transporteur ShipStation vers `Carrier`.
 * Tout code inconnu devient `OTHER` — jamais une erreur : une étiquette
 * créée avec un transporteur non prévu doit quand même produire une
 * expédition suivie chez nous.
 */
export function normalizeCarrierCode(code: string | null | undefined): Carrier {
  if (!code) return 'OTHER';
  const flat = flatten(code);
  const exact = CARRIER_BY_FLAT_CODE[flat];
  if (exact) return exact;
  // Codes composés (« canadapost_ca », « purolator_ground ») : préfixe connu.
  for (const [known, carrier] of Object.entries(CARRIER_BY_FLAT_CODE)) {
    if (flat.includes(known)) return carrier;
  }
  return 'OTHER';
}

/* ------------------------- Statuts d'expédition ------------------------- */

/**
 * Libellés bilingues des statuts de colis (page « Mes colis », courriels,
 * admin, mobile). L'enum vient de la tâche 04 ; les adapters de repérage
 * (tâche 14) y ramènent tous les codes transporteur.
 */
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, LocalizedText> = {
  CREATED: { fr: 'Étiquette créée', en: 'Label created' },
  PICKED_UP: { fr: 'Pris en charge', en: 'Picked up' },
  IN_TRANSIT: { fr: 'En transit', en: 'In transit' },
  OUT_FOR_DELIVERY: { fr: 'En livraison', en: 'Out for delivery' },
  DELIVERED: { fr: 'Livré', en: 'Delivered' },
  EXCEPTION: { fr: 'Incident de livraison', en: 'Delivery exception' },
  RETURNED: { fr: 'Retourné à l’expéditeur', en: 'Returned to sender' },
};

export function shipmentStatusLabel(status: ShipmentStatus, locale: Locale): string {
  return SHIPMENT_STATUS_LABELS[status][locale];
}

/**
 * Statuts FINAUX : le colis ne bougera plus, le polling de repérage s'arrête
 * définitivement (tâche 14). `EXCEPTION` n'est PAS final : un colis en
 * incident peut repartir (reprise en transit, nouvelle tentative, retour).
 */
export const FINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['DELIVERED', 'RETURNED'];

export function isFinalShipmentStatus(status: ShipmentStatus): boolean {
  return FINAL_SHIPMENT_STATUSES.includes(status);
}

/**
 * Page de repérage publique du transporteur. `null` quand nous n'en
 * connaissons pas (OTHER) : les courriels omettent alors le bouton de suivi.
 *
 * La tâche 14 branche les adapters de repérage (événements détaillés) ;
 * ces liens restent la porte de sortie vers le site du transporteur.
 */
export function trackingUrlFor(
  carrier: Carrier,
  trackingNumber: string | null | undefined,
  locale: Locale = 'fr',
): string | null {
  if (!trackingNumber) return null;
  const number = encodeURIComponent(trackingNumber.trim());
  switch (carrier) {
    case 'CANADA_POST':
      return `https://www.canadapost-postescanada.ca/track-reperage/${locale}#/resultList?searchFor=${number}`;
    case 'PUROLATOR':
      return `https://www.purolator.com/${locale}/shipping/tracker?pins=${number}`;
    case 'CANPAR':
      return `https://www.canpar.com/${locale}/tracking/track.htm?barcode=${number}`;
    case 'NATIONEX':
      return `https://www.nationex.com/${locale}/tracking?id=${number}`;
    case 'OTHER':
      return null;
  }
}
