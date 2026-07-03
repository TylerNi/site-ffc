import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from './helpers';

/** Contraintes CHECK ajoutées par la migration contraintes_et_triggers. */
describe('contraintes CHECK au niveau base', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('un panier doit appartenir à un compte OU porter un jeton invité', async () => {
    await expect(prisma.cart.create({ data: {} })).rejects.toThrow(/carts_owner_check|check/i);

    const guestCart = await prisma.cart.create({
      data: { guestToken: `jeton-test-${Date.now()}` },
    });
    expect(guestCart.userId).toBeNull();
  });

  it('une note d’avis doit être entre 1 et 5', async () => {
    const product = await prisma.product.findFirstOrThrow();
    await expect(
      prisma.review.create({
        data: {
          productId: product.id,
          rating: 6,
          authorName: 'Testeur',
        },
      }),
    ).rejects.toThrow(/reviews_rating_check|check/i);
  });

  it('quantités et montants négatifs sont refusés', async () => {
    const cart = await prisma.cart.create({
      data: { guestToken: `jeton-checks-${Date.now()}` },
    });
    const variant = await prisma.productVariant.findFirstOrThrow();

    await expect(
      prisma.cartItem.create({
        data: { cartId: cart.id, variantId: variant.id, quantity: 0 },
      }),
    ).rejects.toThrow(/cart_items_quantity_check|check/i);

    await expect(
      prisma.productVariant.update({
        where: { id: variant.id },
        data: { priceCents: -1 },
      }),
    ).rejects.toThrow(/product_variants_amounts_check|check/i);
  });

  it('un pourcentage de coupon hors 1–100 est refusé', async () => {
    await expect(
      prisma.coupon.create({
        data: { code: `TEST${Date.now()}`, type: 'PERCENTAGE', valuePercent: 150 },
      }),
    ).rejects.toThrow(/coupons_percent_check|check/i);
  });
});
