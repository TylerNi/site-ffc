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
    expect(await prisma.product.count()).toBe(40);
    expect(await prisma.brand.count()).toBe(3);
    expect(await prisma.equipmentModel.count()).toBeGreaterThanOrEqual(5);
    expect(await prisma.modelFilterCompatibility.count()).toBeGreaterThan(0);
    expect(await prisma.supplier.count()).toBe(2);

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
    const before = {
      products: await prisma.product.count(),
      variants: await prisma.productVariant.count(),
      users: await prisma.user.count(),
      orders: await prisma.order.count(),
      invoices: await prisma.invoice.count(),
      movements: await prisma.inventoryMovement.count(),
      compatibilities: await prisma.modelFilterCompatibility.count(),
    };

    await seed(prisma);

    expect({
      products: await prisma.product.count(),
      variants: await prisma.productVariant.count(),
      users: await prisma.user.count(),
      orders: await prisma.order.count(),
      invoices: await prisma.invoice.count(),
      movements: await prisma.inventoryMovement.count(),
      compatibilities: await prisma.modelFilterCompatibility.count(),
    }).toEqual(before);
  });
});
