import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './auth-helpers';
import {
  type CheckoutTestContext,
  createCheckoutTestApp,
  createSession,
  createTestVariant,
  guestAdd,
  postWebhook,
  type SessionResponse,
  type TestVariant,
} from './checkout-helpers';

/**
 * Webhooks Stripe (tâche 11) : signature vérifiée, idempotence par
 * webhook_events, REJEU sans double effet (commande, courriel, stock,
 * coupon), remboursements et litiges.
 */
describe('webhooks Stripe — signature, idempotence, rejeu', () => {
  let ctx: CheckoutTestContext;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Achat prêt à payer : panier invité + session. */
  async function readyOrder(couponCode?: string): Promise<{
    variant: TestVariant;
    session: SessionResponse;
    email: string;
  }> {
    const email = uniqueEmail('webhook');
    const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 8 });
    const token = await guestAdd(ctx, variant.variantId, 2);
    const session = await createSession(ctx, { token, email, couponCode });
    return { variant, session, email };
  }

  it('signature invalide ou absente : 400, rien n’est enregistré', async () => {
    const before = await ctx.prisma.webhookEvent.count();

    await ctx
      .http()
      .post('/v1/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{"id":"evt_sans_signature"}')
      .expect(400);

    // Payload signé avec un MAUVAIS secret.
    const forged = ctx.stripe.signedEvent(
      'payment_intent.succeeded',
      { id: 'pi_forge' },
      undefined,
      'whsec_mauvais_secret',
    );
    await ctx
      .http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', forged.signature)
      .set('content-type', 'application/json')
      .send(forged.payload)
      .expect(400);

    // Payload ALTÉRÉ après signature.
    const valid = ctx.stripe.signedEvent('payment_intent.succeeded', { id: 'pi_x' });
    await ctx
      .http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', valid.signature)
      .set('content-type', 'application/json')
      .send(valid.payload.replace('pi_x', 'pi_y'))
      .expect(400);

    expect(await ctx.prisma.webhookEvent.count()).toBe(before);
  });

  it('événement non couvert : 200, consigné IGNORED', async () => {
    const { eventId } = await postWebhook(ctx, 'customer.created', { id: 'cus_test_1' });
    const row = await ctx.prisma.webhookEvent.findUniqueOrThrow({
      where: { source_externalId: { source: 'stripe', externalId: eventId } },
    });
    expect(row.status).toBe('IGNORED');
    expect(row.processedAt).not.toBeNull();
  });

  it('REJEU de payment_intent.succeeded : zéro duplication (commande, stock, coupon, courriel)', async () => {
    const { variant, session, email } = await readyOrder('BIENVENUE10');
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);

    // Première livraison de l'événement.
    const first = await postWebhook(ctx, 'payment_intent.succeeded', intent, 'evt_rejeu_1');
    expect(first.body.duplicate).toBeUndefined();

    const snapshot = async () => ({
      order: await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } }),
      movements: await ctx.prisma.inventoryMovement.count({
        where: { orderId: session.order.id },
      }),
      level: await ctx.prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId: variant.variantId },
      }),
      redemptions: await ctx.prisma.couponRedemption.count({
        where: { orderId: session.order.id },
      }),
      coupon: await ctx.prisma.coupon.findUniqueOrThrow({ where: { code: 'BIENVENUE10' } }),
      mails: ctx.mail.outbox.filter(
        (entry) => entry.to === email && entry.templateKey === 'order_confirmation',
      ).length,
      paidTransitions: await ctx.prisma.orderStatusHistory.count({
        where: { orderId: session.order.id, toStatus: 'PAID' },
      }),
    });

    const after = await snapshot();
    expect(after.order.status).toBe('PAID');
    expect(after.movements).toBe(1);
    expect(after.level.quantityOnHand).toBe(6); // 8 − 2
    expect(after.redemptions).toBe(1);
    expect(after.mails).toBe(1);
    expect(after.paidTransitions).toBe(1);

    // REJEU 1 : exactement le même événement (même id, même signature valide).
    const replay = await postWebhook(ctx, 'payment_intent.succeeded', intent, 'evt_rejeu_1');
    expect(replay.body.duplicate).toBe(true);

    // REJEU 2 : Stripe renvoie parfois le même événement avec une NOUVELLE
    // signature — l'unicité (source, external_id) le neutralise aussi.
    const replayBis = await postWebhook(ctx, 'payment_intent.succeeded', intent, 'evt_rejeu_1');
    expect(replayBis.body.duplicate).toBe(true);

    const finalState = await snapshot();
    expect(finalState).toEqual(after); // RIEN n'a bougé : zéro double effet

    // Un seul enregistrement webhook pour cet id.
    const rows = await ctx.prisma.webhookEvent.findMany({
      where: { source: 'stripe', externalId: 'evt_rejeu_1' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PROCESSED');
  });

  it('événements DISTINCTS pour le même paiement : le second ne refait rien', async () => {
    const { session } = await readyOrder();
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);

    await postWebhook(ctx, 'payment_intent.succeeded', intent); // evt A
    await postWebhook(ctx, 'payment_intent.succeeded', intent); // evt B (autre id)

    const movements = await ctx.prisma.inventoryMovement.count({
      where: { orderId: session.order.id },
    });
    expect(movements).toBe(1); // la finalisation conditionnelle a tenu
    const paidTransitions = await ctx.prisma.orderStatusHistory.count({
      where: { orderId: session.order.id, toStatus: 'PAID' },
    });
    expect(paidTransitions).toBe(1);
  });

  it('charge.refunded intégral : commande REFUNDED, remboursement consigné, rejeu neutre', async () => {
    const { session } = await readyOrder();
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);
    await postWebhook(ctx, 'payment_intent.succeeded', intent);

    // Remboursement intégral côté Stripe (Dashboard, par exemple).
    await ctx.stripe.createRefund({
      paymentIntentId: session.paymentIntentId,
      reason: 'demande_client',
    });
    const charge = intent.latest_charge;
    if (!charge || typeof charge !== 'object') throw new Error('charge manquante');

    await postWebhook(ctx, 'charge.refunded', charge, 'evt_refund_full');

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } });
    expect(order.status).toBe('REFUNDED');
    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'STRIPE', externalId: session.paymentIntentId } },
    });
    expect(payment.status).toBe('REFUNDED');
    const refunds = await ctx.prisma.refund.findMany({ where: { orderId: session.order.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('SUCCEEDED');
    expect(refunds[0]!.amountCents).toBe(session.order.totalCents);

    // Rejeu : aucun doublon de remboursement, statut inchangé.
    await postWebhook(ctx, 'charge.refunded', charge, 'evt_refund_full');
    expect(await ctx.prisma.refund.count({ where: { orderId: session.order.id } })).toBe(1);
  });

  it('remboursement PARTIEL : PARTIALLY_REFUNDED', async () => {
    const { session } = await readyOrder();
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);
    await postWebhook(ctx, 'payment_intent.succeeded', intent);

    const charge = intent.latest_charge;
    if (!charge || typeof charge !== 'object') throw new Error('charge manquante');
    // Remboursement partiel simulé : la moitié, avec la liste dans le payload
    // (couvre le chemin « refunds embarqués » en plus du repli API).
    const half = Math.floor(charge.amount / 2);
    const partialCharge = {
      ...charge,
      amount_refunded: half,
      refunds: {
        object: 'list',
        data: [
          {
            id: 're_partiel_1',
            object: 'refund',
            amount: half,
            charge: charge.id,
            payment_intent: session.paymentIntentId,
            currency: 'cad',
            status: 'succeeded',
            reason: 'requested_by_customer',
            metadata: {},
          },
        ],
      },
    };

    await postWebhook(ctx, 'charge.refunded', partialCharge);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } });
    expect(order.status).toBe('PARTIALLY_REFUNDED');
    const refund = await ctx.prisma.refund.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'STRIPE', externalId: 're_partiel_1' } },
    });
    expect(refund.amountCents).toBe(half);
  });

  it('charge.dispute.created : audité + note interne, rejeu sans double note', async () => {
    const { session } = await readyOrder();
    ctx.stripe.confirm(session.paymentIntentId, 'success');
    const intent = ctx.stripe.peek(session.paymentIntentId);
    await postWebhook(ctx, 'payment_intent.succeeded', intent);

    const dispute = {
      id: 'dp_test_0001',
      object: 'dispute',
      amount: session.order.totalCents,
      currency: 'cad',
      payment_intent: session.paymentIntentId,
      reason: 'fraudulent',
      status: 'needs_response',
    };
    await postWebhook(ctx, 'charge.dispute.created', dispute, 'evt_dispute_1');

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } });
    expect(order.internalNote).toContain('dp_test_0001');
    expect(order.status).toBe('PAID'); // le litige n'altère pas le statut

    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'order.dispute_created', entityId: session.order.id },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Rejeu (nouvel id d'événement, même litige) : pas de double note.
    await postWebhook(ctx, 'charge.dispute.created', dispute, 'evt_dispute_2');
    const after = await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } });
    expect(after.internalNote!.match(/dp_test_0001/g)).toHaveLength(1);
  });

  it('webhook pour un paiement inconnu de la boutique : IGNORED, pas d’erreur', async () => {
    const { eventId } = await postWebhook(ctx, 'charge.refunded', {
      id: 'ch_etranger',
      object: 'charge',
      amount: 1000,
      amount_refunded: 1000,
      payment_intent: 'pi_etranger',
      currency: 'cad',
    });
    const row = await ctx.prisma.webhookEvent.findUniqueOrThrow({
      where: { source_externalId: { source: 'stripe', externalId: eventId } },
    });
    expect(row.status).toBe('IGNORED');
  });
});
