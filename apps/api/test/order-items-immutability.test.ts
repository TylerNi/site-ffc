import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from './helpers';

/**
 * Les order_items sont des INSTANTANÉS d'achat :
 *   1. un trigger SQL interdit toute modification des colonnes copiées ;
 *   2. modifier le produit/la variante après coup ne change pas la commande.
 */
describe('order_items — immuabilité de l’instantané d’achat', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuse un UPDATE du prix figé (trigger SQL)', async () => {
    const item = await prisma.orderItem.findFirstOrThrow();
    await expect(
      prisma.orderItem.update({
        where: { id: item.id },
        data: { unitPriceCents: item.unitPriceCents + 1000 },
      }),
    ).rejects.toThrow(/immuable/i);
  });

  it('refuse aussi de modifier le nom figé', async () => {
    const item = await prisma.orderItem.findFirstOrThrow();
    await expect(
      prisma.orderItem.update({
        where: { id: item.id },
        data: { nameFr: 'Nom trafiqué' },
      }),
    ).rejects.toThrow(/immuable/i);
  });

  it('changer le prix de la variante ne touche pas la commande passée', async () => {
    const item = await prisma.orderItem.findFirstOrThrow({
      where: { variantId: { not: null } },
    });
    const variantId = item.variantId as string;
    const before = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { priceCents: variant.priceCents + 5000 },
    });

    const after = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.unitPriceCents).toBe(before.unitPriceCents);
    expect(after.nameFr).toBe(before.nameFr);
    expect(after.totalCents).toBe(before.totalCents);

    // Remise en état du catalogue seedé.
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { priceCents: variant.priceCents },
    });
  });

  it('la suppression d’une variante vendue laisse l’instantané intact (SetNull)', async () => {
    // Variante jetable créée pour le test, vendue dans une commande jetable.
    const catalogVariant = await prisma.productVariant.findFirstOrThrow({
      include: { product: true },
    });
    const disposable = await prisma.productVariant.create({
      data: {
        productId: catalogVariant.productId,
        sku: `TEST-JETABLE-${Date.now()}`,
        nominalLabel: '16x25x1',
        nominalWidthIn: '16.00',
        nominalHeightIn: '25.00',
        nominalDepthIn: '1.00',
        actualWidthIn: '15.75',
        actualHeightIn: '24.75',
        actualDepthIn: '0.75',
        merv: 8,
        packSize: 1,
        priceCents: 1234,
      },
    });
    const order = await prisma.order.create({
      data: {
        number: `TEST-IMMU-${Date.now()}`,
        status: 'PAID',
        guestEmail: 'invite.immutabilite@example.com',
        subtotalCents: 1234,
        totalCents: 1234,
        items: {
          create: {
            variantId: disposable.id,
            sku: disposable.sku,
            nameFr: 'Filtre jetable FR',
            nameEn: 'Disposable filter EN',
            quantity: 1,
            unitPriceCents: 1234,
            subtotalCents: 1234,
            totalCents: 1234,
          },
        },
      },
      include: { items: true },
    });

    await prisma.productVariant.delete({ where: { id: disposable.id } });

    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: order.items[0]!.id } });
    expect(item.variantId).toBeNull(); // référence coupée…
    expect(item.sku).toBe(disposable.sku); // …mais l'instantané reste complet
    expect(item.unitPriceCents).toBe(1234);
  });
});
