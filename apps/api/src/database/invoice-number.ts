import type { InvoiceKind, Prisma } from '@prisma/client';

/**
 * Numérotation des factures — séquentielle et SANS TROU par série annuelle.
 *
 * Stratégie (détaillée dans docs/database.md) :
 *   - Une ligne de compteur par série dans `invoice_counters`.
 *   - La fonction SQL `allocate_invoice_number(series)` incrémente le compteur
 *     par un UPSERT : le verrou de ligne pris par l'UPDATE sérialise les
 *     transactions concurrentes, et un ROLLBACK restitue le numéro.
 *   - L'allocation DOIT se faire dans LA MÊME transaction que l'insertion de
 *     la facture : c'est ce qui garantit l'absence de trou.
 *
 * N'allouez JAMAIS de numéro hors transaction (un échec d'insertion créerait
 * un trou définitif dans la série).
 */

/** Préfixe de série par type de document : factures INV, notes de crédit CRN. */
export const INVOICE_SERIES_PREFIXES: Record<InvoiceKind, string> = {
  INVOICE: 'INV',
  CREDIT_NOTE: 'CRN',
};

/**
 * Année fiscale (calendrier) au fuseau de Montréal — une facture émise le
 * 31 décembre à 23 h heure locale appartient à l'année locale, pas à l'année UTC.
 */
export function invoiceYear(date: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
    }).format(date),
  );
}

/** Série annuelle d'un document, ex. « INV-2026 » ou « CRN-2026 ». */
export function invoiceSeries(kind: InvoiceKind, date: Date = new Date()): string {
  return `${INVOICE_SERIES_PREFIXES[kind]}-${invoiceYear(date)}`;
}

/** Numéro complet affiché, ex. « INV-2026-000042 ». */
export function formatInvoiceNumber(series: string, sequence: number): string {
  return `${series}-${String(sequence).padStart(6, '0')}`;
}

export interface AllocatedInvoiceNumber {
  series: string;
  sequence: number;
  number: string;
}

/**
 * Alloue le prochain numéro d'une série. À appeler UNIQUEMENT avec le client
 * transactionnel (`prisma.$transaction(async (tx) => { … })`) de la
 * transaction qui insère la facture.
 */
export async function allocateInvoiceNumber(
  tx: Prisma.TransactionClient,
  series: string,
): Promise<AllocatedInvoiceNumber> {
  const rows = await tx.$queryRaw<
    Array<{ sequence: number }>
  >`SELECT allocate_invoice_number(${series}) AS sequence`;
  const sequence = rows[0]?.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`allocate_invoice_number(${series}) a renvoyé une valeur inattendue`);
  }
  return { series, sequence, number: formatInvoiceNumber(series, sequence) };
}
