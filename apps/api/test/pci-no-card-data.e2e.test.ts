import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './auth-helpers';
import {
  type CheckoutTestContext,
  createCheckoutTestApp,
  createSession,
  createTestVariant,
  guestAdd,
  payAndGetResult,
  postWebhook,
} from './checkout-helpers';

/**
 * Revue PCI SAQ A (tâche 11) : AUCUNE donnée de carte ne touche nos
 * serveurs. La saisie vit dans le Payment Element (iframe Stripe) ; nos
 * enregistrements ne retiennent que marque + 4 derniers chiffres.
 *
 * Ce test AUTOMATISE la revue : schéma sans colonne de carte, base sans
 * PAN après un achat complet (webhooks compris), DTO du checkout sans
 * champ de carte accepté.
 */
describe('revue PCI — aucune donnée de carte', () => {
  let ctx: CheckoutTestContext;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('le schéma n’a AUCUNE colonne susceptible de porter un numéro de carte ou un CVC', () => {
    // « expiresAt » (jetons, paniers) est légitime — seuls les motifs
    // d'EXPIRATION DE CARTE (mois/année/date) sont interdits.
    const forbidden =
      /(card_?number|\bpan\b|cvc|cvv|security_?code|exp(iry|iration)?_?(month|year|date)|card_?exp)/i;
    const offenders: string[] = [];
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        const dbName = `${model.name}.${field.name}`;
        if (forbidden.test(field.name)) offenders.push(dbName);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('après un achat complet, aucun PAN nulle part en base (paiement, webhooks, notifications, audit)', async () => {
    const email = uniqueEmail('pci');
    const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 1);
    const session = await createSession(ctx, { token, email });
    const result = await payAndGetResult(ctx, session);
    expect(result.status).toBe('paid');

    // Rejoue aussi le webhook (payload stocké en base dans webhook_events).
    const intent = ctx.stripe.peek(session.paymentIntentId);
    await postWebhook(ctx, 'payment_intent.succeeded', intent);

    // Un PAN brut est une suite CONTIGUË de 13 à 19 chiffres (un UUID ne
    // dépasse jamais 12 chiffres consécutifs, un timestamp ISO 8) ; un PAN
    // formaté est en groupes de 4 NON entourés de tirets/hex (ce qui écarte
    // les segments internes d'UUID, tout-numériques par hasard).
    const rawPan = /(?<!\d)\d{13,19}(?!\d)/;
    const groupedPan = /(?<![0-9A-Fa-f-])\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?![0-9A-Fa-f-])/;
    const panPattern = new RegExp(`${rawPan.source}|${groupedPan.source}`);

    const dumps: Array<[string, unknown]> = [
      [
        'orders',
        await ctx.prisma.order.findUnique({
          where: { id: session.order.id },
          include: { items: true, payments: true, refunds: true, statusHistory: true },
        }),
      ],
      ['webhook_events', await ctx.prisma.webhookEvent.findMany({ where: { source: 'stripe' } })],
      ['notifications', await ctx.prisma.notification.findMany({ where: { destination: email } })],
      ['audit_logs', await ctx.prisma.auditLog.findMany({ where: { entityId: session.order.id } })],
      ['outbox', ctx.mail.outbox.filter((entry) => entry.to === email)],
    ];

    for (const [table, dump] of dumps) {
      const text = JSON.stringify(dump);
      const match = text.match(panPattern);
      expect(match, `séquence de type PAN trouvée dans ${table} : ${match?.[0]}`).toBeNull();
    }

    // Le paiement ne retient QUE la marque et les 4 derniers chiffres.
    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'STRIPE', externalId: session.paymentIntentId } },
    });
    expect(payment.cardBrand).toBe('visa');
    expect(payment.cardLast4).toHaveLength(4);
  });

  it('le checkout REJETTE silencieusement tout champ de carte envoyé par un client', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 5_000, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 1);

    // Un client (mal intentionné ou mal codé) poste un numéro de carte :
    // la whitelist du ValidationPipe retire les champs inconnus — rien ne
    // traverse jusqu'aux services ni à la base.
    const session = await ctx
      .http()
      .post('/v1/checkout/session')
      .set('X-Cart-Token', token)
      .send({
        email: uniqueEmail('pci-dto'),
        shippingAddress: {
          firstName: 'A',
          lastName: 'B',
          line1: '1 rue Test',
          city: 'Montréal',
          province: 'QC',
          postalCode: 'H2L 2G8',
          country: 'CA',
        },
        cardNumber: '4242424242424242',
        cvc: '123',
      })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { id: session.body.order.id },
    });
    expect(JSON.stringify(order)).not.toContain('4242424242424242');
  });
});
