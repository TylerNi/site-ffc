import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateInvoiceNumber, formatInvoiceNumber } from '../src/database/invoice-number';
import { createTestClient } from './helpers';

/**
 * Critère d'acceptation : numérotation de factures séquentielle SANS TROU
 * par série, y compris sous transactions PARALLÈLES et malgré les rollbacks.
 */
describe('invoices — séquence sans trou sous concurrence', () => {
  let prisma: PrismaClient;
  let orderId: string;

  beforeAll(async () => {
    // Assez de connexions pour exécuter réellement les transactions en parallèle.
    prisma = createTestClient({ connectionLimit: 15 });
    const order = await prisma.order.findFirstOrThrow({ select: { id: true } });
    orderId = order.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createInvoiceInSeries(series: string): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const allocated = await allocateInvoiceNumber(tx, series);
      await tx.invoice.create({
        data: {
          orderId,
          kind: 'INVOICE',
          series: allocated.series,
          sequence: allocated.sequence,
          number: allocated.number,
          subtotalCents: 1000,
          totalCents: 1000,
        },
      });
      return allocated.sequence;
    });
  }

  it('12 transactions parallèles obtiennent 1..12 sans trou ni doublon', async () => {
    const series = 'TEST-PARALLELE-2099';
    const results = await Promise.all(
      Array.from({ length: 12 }, () => createInvoiceInSeries(series)),
    );

    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    const invoices = await prisma.invoice.findMany({
      where: { series },
      orderBy: { sequence: 'asc' },
    });
    expect(invoices).toHaveLength(12);
    expect(invoices.map((invoice) => invoice.sequence)).toEqual(sorted);
    expect(invoices.at(-1)?.number).toBe(formatInvoiceNumber(series, 12));

    const counter = await prisma.invoiceCounter.findUniqueOrThrow({ where: { series } });
    expect(counter.lastValue).toBe(12);
  });

  it('un ROLLBACK restitue le numéro : jamais de trou', async () => {
    const series = 'TEST-ROLLBACK-2099';

    const first = await createInvoiceInSeries(series);
    expect(first).toBe(1);

    // Transaction qui alloue le 2 puis échoue → le compteur doit revenir à 1.
    await expect(
      prisma.$transaction(async (tx) => {
        await allocateInvoiceNumber(tx, series);
        throw new Error('échec simulé après allocation');
      }),
    ).rejects.toThrow('échec simulé');

    const second = await createInvoiceInSeries(series);
    expect(second).toBe(2); // le numéro libéré est réutilisé — pas de trou

    const sequences = await prisma.invoice.findMany({
      where: { series },
      orderBy: { sequence: 'asc' },
      select: { sequence: true },
    });
    expect(sequences.map((s) => s.sequence)).toEqual([1, 2]);
  });

  it('les séries sont indépendantes (INV vs CRN, par année)', async () => {
    const a = await createInvoiceInSeries('TEST-SERIE-A-2099');
    const b = await createInvoiceInSeries('TEST-SERIE-B-2099');
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('l’unicité (series, sequence) est verrouillée en base', async () => {
    const series = 'TEST-UNIQUE-2099';
    await createInvoiceInSeries(series);
    await expect(
      prisma.invoice.create({
        data: {
          orderId,
          series,
          sequence: 1,
          number: formatInvoiceNumber(series, 1),
          subtotalCents: 1,
          totalCents: 1,
        },
      }),
    ).rejects.toThrow(); // P2002 sur @@unique([series, sequence]) — et sur number
  });
});
