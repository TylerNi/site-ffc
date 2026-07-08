import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed';
import { createTestClient } from './helpers';

/**
 * Critère d'acceptation : `prisma migrate reset && prisma db seed`
 * reproductible. Le globalSetup vient de faire reset + seed ; on vérifie ici
 * le contenu ET l'idempotence (re-seed sans doublon).
 */
describe('seed — contenu et reproductibilité', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('le contenu attendu du brief est présent', async () => {
    // Comptes restreints aux IDENTIFIANTS DÉTERMINISTES du seed : la base
    // de test est partagée avec les suites checkout (tâche 11) qui créent
    // leurs produits en parallèle (ids UUID v7 aléatoires, hors plage).
    expect(await prisma.product.count({ where: { id: seedIdRange(3) } })).toBe(40);
    expect(await prisma.brand.count({ where: { id: seedIdRange(1) } })).toBe(3);
    expect(await prisma.equipmentModel.count()).toBeGreaterThanOrEqual(5);
    expect(await prisma.modelFilterCompatibility.count()).toBeGreaterThan(0);
    expect(await prisma.supplier.count({ where: { id: seedIdRange(7) } })).toBe(2);

    const admin = await prisma.user.findUnique({
      where: { email: 'admin@filtrationmontreal.com' },
      include: { roleAssignments: true },
    });
    expect(admin?.role).toBe('ADMIN');
    expect(admin?.roleAssignments.length).toBeGreaterThan(0);

    const order = await prisma.order.findFirst({
      where: { user: { email: 'client.test@example.com' } },
      include: {
        items: true,
        payments: true,
        invoices: true,
        shipments: { include: { events: true } },
        statusHistory: true,
      },
    });
    expect(order).not.toBeNull();
    expect(order?.number).toMatch(/^FFC-\d+$/);
    expect(order?.items.length).toBe(2);
    expect(order?.payments[0]?.status).toBe('SUCCEEDED');
    expect(order?.invoices[0]?.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(order?.shipments[0]?.trackingNumber).toBe('CP123456789CA');
    expect(order?.shipments[0]?.events.length).toBeGreaterThanOrEqual(3);
    expect(order?.statusHistory.length).toBeGreaterThanOrEqual(4);

    // Cohérence financière de la commande de démo (tout en cents).
    if (order) {
      const itemsTotal = order.items.reduce((sum, item) => sum + item.subtotalCents, 0);
      expect(itemsTotal).toBe(order.subtotalCents - order.discountCents);
      expect(order.totalCents).toBe(
        order.subtotalCents -
          order.discountCents +
          order.shippingCents +
          order.taxGstCents +
          order.taxQstCents +
          order.taxHstCents +
          order.taxPstCents,
      );
    }
  });

  it('relancer le seed ne crée aucun doublon (idempotence)', async () => {
    // Instantané restreint aux données DU SEED : les suites parallèles
    // (checkout) écrivent leurs propres lignes entre les deux mesures — le
    // périmètre seedé, lui, doit rester strictement identique.
    const snapshot = async () => ({
      products: await prisma.product.count({ where: { id: seedIdRange(3) } }),
      variants: await prisma.productVariant.count({ where: { id: seedIdRange(4) } }),
      users: await prisma.user.count({ where: { id: seedIdRange(8) } }),
      orders: await prisma.order.count({ where: { id: seedIdRange(11) } }),
      invoices: await prisma.invoice.count({ where: { orderId: seedIdRange(11) } }),
      movements: await prisma.inventoryMovement.count({
        where: { variantId: seedIdRange(4) },
      }),
      compatibilities: await prisma.modelFilterCompatibility.count({
        where: { variantId: seedIdRange(4) },
      }),
    });

    const before = await snapshot();
    await seed(prisma);
    expect(await snapshot()).toEqual(before);
  });
});

/** Plage d'ids déterministes d'un bloc du seed (voir seedId dans prisma/seed.ts). */
function seedIdRange(block: number): { gte: string; lte: string } {
  const prefix = `00000000-0000-4000-8${String(block).padStart(3, '0')}`;
  return { gte: `${prefix}-000000000000`, lte: `${prefix}-ffffffffffff` };
}
