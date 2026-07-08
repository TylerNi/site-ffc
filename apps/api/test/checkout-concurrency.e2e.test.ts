import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './auth-helpers';
import {
  type CheckoutTestContext,
  createCheckoutTestApp,
  createSession,
  createTestVariant,
  guestAdd,
} from './checkout-helpers';

/**
 * Critère d'acceptation (tâche 11) : deux checkouts SIMULTANÉS sur le
 * dernier article — un seul réussit, l'autre échoue proprement (annulé et
 * remboursé), le stock reste cohérent (0, jamais négatif).
 */
describe('concurrence — dernier article', () => {
  let ctx: CheckoutTestContext;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('deux paiements confirmés en parallèle : un PAID, un CANCELLED+remboursé, stock à 0', async () => {
    // UN seul exemplaire en stock.
    const variant = await createTestVariant(ctx.prisma, { priceCents: 8_000, stock: 1 });

    // Deux clients, deux paniers : chacun voit « 1 disponible » et l'ajoute.
    const tokenA = await guestAdd(ctx, variant.variantId, 1);
    const tokenB = await guestAdd(ctx, variant.variantId, 1);

    // Deux sessions de checkout (deux commandes PENDING, deux intents).
    const sessionA = await createSession(ctx, { token: tokenA, email: uniqueEmail('course-a') });
    const sessionB = await createSession(ctx, { token: tokenB, email: uniqueEmail('course-b') });
    expect(sessionA.order.id).not.toBe(sessionB.order.id);

    // Les deux paiements ABOUTISSENT côté Stripe (les fonds sont captés).
    ctx.stripe.confirm(sessionA.paymentIntentId, 'success');
    ctx.stripe.confirm(sessionB.paymentIntentId, 'success');

    // Finalisations STRICTEMENT simultanées (retour client des deux côtés).
    const [resultA, resultB] = await Promise.all([
      ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: sessionA.paymentIntentId, clientSecret: sessionA.clientSecret })
        .expect(200),
      ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: sessionB.paymentIntentId, clientSecret: sessionB.clientSecret })
        .expect(200),
    ]);

    const statuses = [resultA.body.status, resultB.body.status].sort();
    expect(statuses).toEqual(['cancelled_insufficient_stock', 'paid']);

    // En base : exactement UNE commande payée, UNE annulée.
    const orders = await ctx.prisma.order.findMany({
      where: { id: { in: [sessionA.order.id, sessionB.order.id] } },
    });
    expect(orders.map((order) => order.status).sort()).toEqual(['CANCELLED', 'PAID']);
    const cancelled = orders.find((order) => order.status === 'CANCELLED')!;
    const paid = orders.find((order) => order.status === 'PAID')!;
    expect(cancelled.internalNote).toContain('Stock insuffisant');

    // Stock : 0, jamais négatif ; UN seul mouvement de vente.
    const level = await ctx.prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId: variant.variantId },
    });
    expect(level.quantityOnHand).toBe(0);
    const movements = await ctx.prisma.inventoryMovement.findMany({
      where: { variantId: variant.variantId, type: 'SALE' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.orderId).toBe(paid.id);

    // Le perdant est intégralement remboursé (remboursement Stripe réel + consigné).
    const refunds = await ctx.prisma.refund.findMany({ where: { orderId: cancelled.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountCents).toBe(cancelled.totalCents);
    expect(refunds[0]!.status).toBe('SUCCEEDED');
    const stripeRefunds = [...ctx.stripe.refunds.values()].filter(
      (refund) =>
        refund.payment_intent ===
        (cancelled.id === sessionA.order.id ? sessionA.paymentIntentId : sessionB.paymentIntentId),
    );
    expect(stripeRefunds).toHaveLength(1);

    // Le gagnant ne rembourse rien.
    expect(await ctx.prisma.refund.count({ where: { orderId: paid.id } })).toBe(0);

    // Trace d'audit de l'annulation automatique.
    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'order.cancelled_insufficient_stock', entityId: cancelled.id },
    });
    expect(audits).toHaveLength(1);
  });

  it('webhook et retour client en même temps : une seule finalisation', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 5_000, stock: 4 });
    const token = await guestAdd(ctx, variant.variantId, 1);
    const session = await createSession(ctx, { token, email: uniqueEmail('double-canal') });
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);
    const signed = ctx.stripe.signedEvent('payment_intent.succeeded', intent);

    // Le webhook Stripe et la page de succès arrivent en MÊME temps.
    await Promise.all([
      ctx
        .http()
        .post('/v1/webhooks/stripe')
        .set('stripe-signature', signed.signature)
        .set('content-type', 'application/json')
        .send(signed.payload)
        .expect(200),
      ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: session.paymentIntentId, clientSecret: session.clientSecret })
        .expect(200),
    ]);

    // Une seule finalisation : un mouvement, une transition, un courriel.
    expect(await ctx.prisma.inventoryMovement.count({ where: { orderId: session.order.id } })).toBe(
      1,
    );
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: session.order.id, toStatus: 'PAID' },
      }),
    ).toBe(1);
    const level = await ctx.prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId: variant.variantId },
    });
    expect(level.quantityOnHand).toBe(3);
  });
});
