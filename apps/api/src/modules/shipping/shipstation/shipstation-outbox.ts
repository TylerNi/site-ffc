import { type Prisma, type PrismaClient } from '@prisma/client';

/**
 * BOÎTE D'ENVOI ShipStation — fonctions PURES sur `shipstation_syncs`,
 * sans injection Nest.
 *
 * Ce fichier est une FEUILLE : le module « commandes » (finalisation,
 * annulation) l'importe pour armer ou désarmer la poussée sans jamais
 * dépendre du module d'expédition — aucun cycle, et surtout la ligne
 * d'envoi est écrite dans LA MÊME transaction que le passage à `PAID`.
 * Si le processus meurt juste après le commit, la commande sera poussée
 * au prochain passage du drain : rien ne se perd.
 */

/** Un client Prisma ou une transaction Prisma. */
export type PrismaLike = PrismaClient | Prisma.TransactionClient;

/** Retentatives avant de basculer la ligne en file d'échec (`SYNC_FAILED`). */
export const SHIPSTATION_MAX_ATTEMPTS = 5;

/** Recul exponentiel : 30 s, 1 min, 2 min, 4 min… plafonné à 15 min. */
export const SHIPSTATION_BACKOFF_BASE_MS = 30_000;
export const SHIPSTATION_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Bail de traitement : le drain repousse `next_attempt_at` avant l'appel
 * réseau, si bien qu'une seconde instance ne reprend pas la même ligne
 * (et qu'un processus tué laisse la ligne retentable après ce délai).
 */
export const SHIPSTATION_LEASE_MS = 2 * 60_000;

export function backoffDelayMs(attempts: number): number {
  const delay = SHIPSTATION_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, SHIPSTATION_BACKOFF_MAX_MS);
}

/**
 * Arme la poussée d'une commande payée. Appelée dans la transaction de
 * finalisation. Un rejeu (webhook Stripe doublé) ne réarme pas une ligne
 * déjà synchronisée : l'upsert ne touche que les lignes encore en échec.
 */
export async function enqueueShipstationPush(prisma: PrismaLike, orderId: string): Promise<void> {
  await prisma.shipstationSync.upsert({
    where: { orderId },
    create: { orderId, status: 'PENDING', operation: 'CREATE', nextAttemptAt: new Date() },
    // Une ligne SYNCED / CANCELLED / PENDING reste telle quelle ; seule une
    // ligne SYNC_FAILED (création) est réarmée par une nouvelle finalisation.
    update: {},
  });
}

/**
 * Demande l'annulation dans ShipStation d'une commande annulée chez nous.
 *
 * - commande déjà connue de ShipStation → opération `CANCEL` en file ;
 * - commande jamais poussée → la ligne passe `SKIPPED` (rien à annuler).
 *
 * Course résiduelle : si le drain est EN TRAIN de créer la commande, il
 * relit le statut après l'appel et réarme l'annulation lui-même.
 */
export async function requestShipstationCancellation(
  prisma: PrismaLike,
  orderId: string,
): Promise<'CANCEL_QUEUED' | 'NOTHING_TO_CANCEL' | 'NO_SYNC'> {
  const queued = await prisma.shipstationSync.updateMany({
    where: { orderId, shipstationOrderId: { not: null }, status: { not: 'CANCELLED' } },
    data: {
      operation: 'CANCEL',
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
    },
  });
  if (queued.count > 0) return 'CANCEL_QUEUED';

  const skipped = await prisma.shipstationSync.updateMany({
    where: { orderId, shipstationOrderId: null },
    data: { status: 'SKIPPED', operation: 'CANCEL', nextAttemptAt: null, lastError: null },
  });
  return skipped.count > 0 ? 'NOTHING_TO_CANCEL' : 'NO_SYNC';
}

/**
 * Une étiquette existe-t-elle déjà pour cette commande ? Si oui,
 * l'annulation automatique est BLOQUÉE : le colis part (ou est parti), le
 * retrait relève d'un processus manuel dans ShipStation.
 *
 * Deux sources, car un webhook peut arriver avant que l'expédition ne soit
 * enregistrée : l'horodatage d'étiquette de la file, et les expéditions.
 */
export async function hasShipstationLabel(prisma: PrismaLike, orderId: string): Promise<boolean> {
  const [sync, shipment] = await Promise.all([
    prisma.shipstationSync.findUnique({
      where: { orderId },
      select: { labelCreatedAt: true },
    }),
    prisma.shipment.findFirst({ where: { orderId }, select: { id: true } }),
  ]);
  return sync?.labelCreatedAt != null || shipment != null;
}

/**
 * Note qu'une étiquette existe pour cette commande (verrou d'annulation).
 * Idempotent : le premier horodatage gagne.
 */
export async function markShipstationLabelCreated(
  prisma: PrismaLike,
  orderId: string,
  at: Date,
): Promise<void> {
  await prisma.shipstationSync.updateMany({
    where: { orderId, labelCreatedAt: null },
    data: { labelCreatedAt: at },
  });
}
