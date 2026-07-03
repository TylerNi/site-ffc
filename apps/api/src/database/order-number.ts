import type { Prisma } from '@prisma/client';

/**
 * Numéros de commande lisibles « FFC-100042 », alloués par la séquence
 * PostgreSQL `order_number_seq` (migration contraintes_et_triggers).
 *
 * Contrairement aux factures, des trous sont tolérés ici : une séquence
 * native suffit (pas de verrou, aucune contention), seule l'unicité compte.
 */
export const ORDER_NUMBER_PREFIX = 'FFC-';

export async function allocateOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<
    Array<{ value: bigint }>
  >`SELECT nextval('order_number_seq') AS value`;
  const value = rows[0]?.value;
  if (typeof value !== 'bigint' || value < 1n) {
    throw new Error('order_number_seq a renvoyé une valeur inattendue');
  }
  return `${ORDER_NUMBER_PREFIX}${value}`;
}
