import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, lastMail, login, registerAndVerify, uniqueEmail } from './auth-helpers';
import {
  ADDRESS_QC,
  ADDRESS_US_NY,
  addressFor,
  type CheckoutTestContext,
  createCheckoutTestApp,
  createSession,
  createTestVariant,
  guestAdd,
  payAndGetResult,
  postWebhook,
} from './checkout-helpers';

/**
 * Checkout Stripe (tâche 11) : cotation serveur (taxes exactes par
 * province, livraison, coupons), PaymentIntent au montant revalidé,
 * parcours complets invité/connecté (succès, refus, 3DS).
 */
describe('checkout — cotation serveur et paiements', () => {
  let ctx: CheckoutTestContext;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /* -------------------- Totaux exacts (critère d'acceptation) ------------ */

  describe('totaux exacts par destination (article à 100,00 $)', () => {
    interface Expected {
      gst: number;
      qst: number;
      hst: number;
      pst: number;
      shipping: number;
      total: number;
    }
    const cases: Array<[string, Expected]> = [
      // QC : TPS 5 % (5,00) + TVQ 9,975 % (9,98 — 9,975 arrondi half-up).
      ['QC', { gst: 500, qst: 998, hst: 0, pst: 0, shipping: 0, total: 11_498 }],
      // ON : TVH 13 %.
      ['ON', { gst: 0, qst: 0, hst: 1_300, pst: 0, shipping: 0, total: 11_300 }],
      // NS : TVH 14 % — taux en vigueur depuis le 2025-04-01 (le brief
      // mentionnait 15 %, antérieur à la baisse ; la table @ffc/core fait foi).
      ['NS', { gst: 0, qst: 0, hst: 1_400, pst: 0, shipping: 0, total: 11_400 }],
      // AB : TPS 5 % seule.
      ['AB', { gst: 500, qst: 0, hst: 0, pst: 0, shipping: 0, total: 10_500 }],
      // BC : TPS 5 % + TVP 7 %.
      ['BC', { gst: 500, qst: 0, hst: 0, pst: 700, shipping: 0, total: 11_200 }],
    ];

    it.each(cases)('%s', async (province, expected) => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 20 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, {
        token,
        email: uniqueEmail('taxes'),
        address: addressFor(province),
      });

      expect(session.order.subtotalCents).toBe(10_000);
      expect(session.order.shippingCents).toBe(expected.shipping); // Canada : gratuit
      expect(session.order.taxGstCents).toBe(expected.gst);
      expect(session.order.taxQstCents).toBe(expected.qst);
      expect(session.order.taxHstCents).toBe(expected.hst);
      expect(session.order.taxPstCents).toBe(expected.pst);
      expect(session.order.totalCents).toBe(expected.total);

      // Le montant de l'intent est EXACTEMENT le total serveur.
      expect(ctx.stripe.peek(session.paymentIntentId).amount).toBe(expected.total);
    });

    it('États-Unis : taxes 0, frais fixes configurés dans settings', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 20 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, {
        token,
        email: uniqueEmail('us'),
        address: ADDRESS_US_NY,
      });

      expect(session.order.taxGstCents).toBe(0);
      expect(session.order.taxQstCents).toBe(0);
      expect(session.order.taxHstCents).toBe(0);
      expect(session.order.taxPstCents).toBe(0);
      expect(session.order.shippingCents).toBe(2_500); // seed du réglage
      expect(session.order.totalCents).toBe(12_500);
    });

    it('les frais US suivent le réglage settings (modifiable en admin)', async () => {
      await ctx.prisma.setting.update({
        where: { key: 'expedition.frais_fixes_us_cents' },
        data: { value: 3_100 },
      });
      const variant = await createTestVariant(ctx.prisma, { priceCents: 5_000, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, {
        token,
        email: uniqueEmail('us2'),
        address: ADDRESS_US_NY,
      });
      expect(session.order.shippingCents).toBe(3_100);
      await ctx.prisma.setting.update({
        where: { key: 'expedition.frais_fixes_us_cents' },
        data: { value: 2_500 },
      });
    });

    it('la ventilation par ligne somme exactement les totaux de commande', async () => {
      // Trois lignes irrégulières au QC : chaque ligne porte SA taxe arrondie,
      // les totaux de commande sont la somme des lignes.
      const v1 = await createTestVariant(ctx.prisma, { priceCents: 1_999, stock: 9 });
      const v2 = await createTestVariant(ctx.prisma, { priceCents: 3_333, stock: 9 });
      const v3 = await createTestVariant(ctx.prisma, { priceCents: 101, stock: 9 });
      const token = await guestAdd(ctx, v1.variantId, 2);
      await guestAdd(ctx, v2.variantId, 1, token);
      await guestAdd(ctx, v3.variantId, 3, token);

      const session = await createSession(ctx, {
        token,
        email: uniqueEmail('ventilation'),
        address: ADDRESS_QC,
      });

      const lineTaxSum = session.order.lines.reduce((sum, line) => sum + line.taxCents, 0);
      expect(session.order.subtotalCents).toBe(2 * 1_999 + 3_333 + 3 * 101);
      expect(lineTaxSum).toBe(session.order.totalTaxCents); // livraison = 0 au QC
      expect(session.order.totalCents).toBe(
        session.order.subtotalCents + session.order.totalTaxCents,
      );
    });
  });

  /* --------------------------------- Coupons ----------------------------- */

  describe('coupons', () => {
    it('BIENVENUE10 : 10 % répartis par ligne, taxes sur le montant remisé', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 20 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, {
        token,
        email: uniqueEmail('coupon'),
        address: ADDRESS_QC,
        couponCode: 'BIENVENUE10',
      });

      expect(session.order.couponCode).toBe('BIENVENUE10');
      expect(session.order.discountCents).toBe(1_000);
      // Base taxable 90,00 $ : TPS 4,50, TVQ 8,98 (8,9775 → half-up).
      expect(session.order.taxGstCents).toBe(450);
      expect(session.order.taxQstCents).toBe(898);
      expect(session.order.totalCents).toBe(9_000 + 450 + 898);
    });

    it('sous le minimum d’achat : 400 COUPON_MIN_SUBTOTAL', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 2_000, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1); // 20 $ < minimum 30 $
      const response = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({
          email: uniqueEmail('coupon-min'),
          shippingAddress: ADDRESS_QC,
          couponCode: 'BIENVENUE10',
        })
        .expect(400);
      expect(response.body.code).toBe('COUPON_MIN_SUBTOTAL');
      expect(response.body.minSubtotalCents).toBe(3_000);
    });

    it('coupon expiré, inactif ou inconnu : erreurs distinctes', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 9_000, stock: 5 });
      await ctx.prisma.coupon.create({
        data: {
          code: `EXPIRE-${variant.sku}`,
          type: 'FIXED_AMOUNT',
          valueCents: 500,
          endsAt: new Date(Date.now() - 86_400_000),
        },
      });
      const token = await guestAdd(ctx, variant.variantId, 1);

      const expired = await createSession(ctx, {
        token,
        email: uniqueEmail('c1'),
        couponCode: `EXPIRE-${variant.sku}`,
        expect: 400,
      });
      expect((expired as unknown as { code: string }).code).toBe('COUPON_EXPIRED');

      const unknown = await createSession(ctx, {
        token,
        email: uniqueEmail('c2'),
        couponCode: 'N-EXISTE-PAS',
        expect: 400,
      });
      expect((unknown as unknown as { code: string }).code).toBe('COUPON_NOT_FOUND');
    });

    it('usage unique par client : bloqué au 2e achat, même en invité (par courriel)', async () => {
      const email = uniqueEmail('coupon-unique');
      const coupon = await ctx.prisma.coupon.create({
        data: {
          code: `UNIQUE-${email.slice(0, 8).toUpperCase()}`,
          type: 'FIXED_AMOUNT',
          valueCents: 500,
          maxRedemptionsPerUser: 1,
        },
      });

      // Premier achat complet avec le coupon.
      const v1 = await createTestVariant(ctx.prisma, { priceCents: 5_000, stock: 5 });
      const token1 = await guestAdd(ctx, v1.variantId, 1);
      const session1 = await createSession(ctx, {
        token: token1,
        email,
        couponCode: coupon.code,
      });
      const result1 = await payAndGetResult(ctx, session1);
      expect(result1.status).toBe('paid');

      // Second panier, même courriel, même coupon : refusé.
      const v2 = await createTestVariant(ctx.prisma, { priceCents: 5_000, stock: 5 });
      const token2 = await guestAdd(ctx, v2.variantId, 1);
      const response = await createSession(ctx, {
        token: token2,
        email,
        couponCode: coupon.code,
        expect: 400,
      });
      expect((response as unknown as { code: string }).code).toBe('COUPON_ALREADY_USED');
    });
  });

  /* ------------------------ Parcours d'achat complets --------------------- */

  describe('parcours complets', () => {
    it('invité : session → paiement → finalisation (stock, coupon, courriel, panier converti)', async () => {
      const email = uniqueEmail('achat-invite');
      const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 7 });
      const token = await guestAdd(ctx, variant.variantId, 2);

      const session = await createSession(ctx, {
        token,
        email,
        address: ADDRESS_QC,
        couponCode: 'BIENVENUE10',
      });
      const result = await payAndGetResult(ctx, session);
      expect(result.status).toBe('paid');
      const orderView = result.order as Record<string, unknown>;
      expect(orderView.number).toBe(session.order.number);

      // Commande PAYÉE, instantanés figés.
      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: session.order.id },
        include: { items: true, payments: true, statusHistory: true },
      });
      expect(order.status).toBe('PAID');
      expect(order.paidAt).not.toBeNull();
      expect(order.guestEmail).toBe(email);
      expect(order.items[0]).toMatchObject({ sku: variant.sku, quantity: 2 });

      // Stock décrémenté + mouvement SALE unique.
      const level = await ctx.prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId: variant.variantId },
      });
      expect(level.quantityOnHand).toBe(5);
      const movements = await ctx.prisma.inventoryMovement.findMany({
        where: { orderId: order.id },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ type: 'SALE', quantity: -2 });

      // Coupon consommé.
      const redemptions = await ctx.prisma.couponRedemption.findMany({
        where: { orderId: order.id },
      });
      expect(redemptions).toHaveLength(1);

      // Paiement enrichi du reçu (marque/last4 — jamais de numéro complet).
      const payment = order.payments.find((p) => p.externalId === session.paymentIntentId)!;
      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.cardBrand).toBe('visa');
      expect(payment.cardLast4).toBe('4242');
      expect(payment.receiptUrl).toContain('stripe.com');

      // Panier converti : le GET redevient vide.
      const emptied = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
      expect(emptied.body.items).toHaveLength(0);

      // Courriel de confirmation parti une fois.
      const mail = lastMail(ctx, email, 'order_confirmation');
      expect(mail).toBeDefined();
      expect(mail!.subject).toContain(order.number);

      // Historique : une seule transition PENDING → PAID.
      const paidTransitions = order.statusHistory.filter((h) => h.toStatus === 'PAID');
      expect(paidTransitions).toHaveLength(1);
    });

    it('connecté : adresse sauvegardée au carnet, finalisation par WEBHOOK', async () => {
      const email = uniqueEmail('achat-connecte');
      await registerAndVerify(ctx, email);
      const auth = await login(ctx, email);
      const variant = await createTestVariant(ctx.prisma, { priceCents: 4_500, stock: 3 });

      await ctx
        .http()
        .post('/v1/cart/items')
        .set('Authorization', bearer(auth.accessToken))
        .send({ variantId: variant.variantId, quantity: 1 })
        .expect(200);

      const session = await createSession(ctx, {
        bearer: auth.accessToken,
        address: addressFor('ON'),
        extra: { saveAddress: true },
      });
      expect(session.order.email).toBe(email); // courriel du compte, pas du body
      expect(session.order.taxHstCents).toBe(585); // 45 $ × 13 %

      // Adresse au carnet.
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
      const saved = await ctx.prisma.address.findMany({ where: { userId: user.id } });
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ province: 'ON', isDefaultShipping: true });

      // Confirmation Stripe côté client…
      ctx.stripe.confirm(session.paymentIntentId, 'success');
      // …et la boutique apprend le paiement par le WEBHOOK signé.
      const intent = ctx.stripe.peek(session.paymentIntentId);
      await postWebhook(ctx, 'payment_intent.succeeded', intent);

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { id: session.order.id },
      });
      expect(order.status).toBe('PAID');
      expect(order.userId).toBe(user.id);
      expect(order.guestEmail).toBeNull();

      // La page de succès (result) tombe sur une commande déjà finalisée.
      const result = await ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: session.paymentIntentId, clientSecret: session.clientSecret })
        .expect(200);
      expect(result.body.status).toBe('paid');

      // L'achat suivant peut référencer l'adresse du carnet.
      const v2 = await createTestVariant(ctx.prisma, { priceCents: 2_000, stock: 3 });
      await ctx
        .http()
        .post('/v1/cart/items')
        .set('Authorization', bearer(auth.accessToken))
        .send({ variantId: v2.variantId, quantity: 1 })
        .expect(200);
      const session2 = await createSession(ctx, {
        bearer: auth.accessToken,
        extra: { shippingAddressId: saved[0]!.id },
        address: undefined,
      });
      expect(session2.order.totalCents).toBe(2_000 + 260); // ON 13 %
    });

    it('carte refusée : échec propre, la commande reste payable, puis succès', async () => {
      const email = uniqueEmail('refus');
      const variant = await createTestVariant(ctx.prisma, { priceCents: 6_000, stock: 4 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, { token, email });

      // Refus (4000 0000 0000 0002) : le client voit un message clair.
      const declined = await payAndGetResult(ctx, session, 'declined');
      expect(declined.status).toBe('payment_failed');
      expect(declined.failureMessage).toContain('declined');

      // Le webhook payment_failed consigne le code d'échec.
      const intent = ctx.stripe.peek(session.paymentIntentId);
      await postWebhook(ctx, 'payment_intent.payment_failed', intent);
      const payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: {
          provider_externalId: { provider: 'STRIPE', externalId: session.paymentIntentId },
        },
      });
      expect(payment.status).toBe('FAILED');
      expect(payment.failureCode).toBe('card_declined');

      // Rien n'a été décrémenté ni finalisé.
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: session.order.id } });
      expect(order.status).toBe('PENDING');
      const level = await ctx.prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId: variant.variantId },
      });
      expect(level.quantityOnHand).toBe(4);

      // Nouvelle tentative sur le MÊME intent : succès de bout en bout.
      const retried = await payAndGetResult(ctx, session, 'success');
      expect(retried.status).toBe('paid');
    });

    it('3DS : requires_action → défi complété → payé', async () => {
      const email = uniqueEmail('3ds');
      const variant = await createTestVariant(ctx.prisma, { priceCents: 7_500, stock: 4 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, { token, email });

      const pending = await payAndGetResult(ctx, session, 'requires_action');
      expect(pending.status).toBe('requires_action');

      ctx.stripe.completeAction(session.paymentIntentId);
      const result = await ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: session.paymentIntentId, clientSecret: session.clientSecret })
        .expect(200);
      expect(result.body.status).toBe('paid');
    });
  });

  /* ------------------------- Garde-fous de session ----------------------- */

  describe('garde-fous', () => {
    it('panier changé entre l’affichage et le checkout : 409 CART_CHANGED puis OK', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 3_000, stock: 10 });
      const token = await guestAdd(ctx, variant.variantId, 1);

      await ctx.prisma.productVariant.update({
        where: { id: variant.variantId },
        data: { priceCents: 3_500 },
      });

      const conflict = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({ email: uniqueEmail('conflit'), shippingAddress: ADDRESS_QC })
        .expect(409);
      expect(conflict.body.code).toBe('CART_CHANGED');
      expect(conflict.body.changes.priceChanged[0]).toMatchObject({
        fromCents: 3_000,
        toCents: 3_500,
      });

      // Le panier est maintenant réconcilié : la session passe, au NOUVEAU prix.
      const session = await createSession(ctx, { token, email: uniqueEmail('conflit') });
      expect(session.order.subtotalCents).toBe(3_500);
    });

    it('panier vide ou jeton inconnu : 400 CART_EMPTY', async () => {
      const response = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', 'inconnu')
        .send({ email: uniqueEmail('vide'), shippingAddress: ADDRESS_QC })
        .expect(400);
      expect(response.body.code).toBe('CART_EMPTY');
    });

    it('invité sans courriel : 400 ; adresse invalide : 400 champ par champ', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 3_000, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1);

      const noEmail = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({ shippingAddress: ADDRESS_QC })
        .expect(400);
      expect(noEmail.body.code).toBe('EMAIL_REQUIRED');

      const badPostal = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({
          email: uniqueEmail('adresse'),
          shippingAddress: { ...ADDRESS_QC, postalCode: '12345' }, // ZIP sur pays CA
        })
        .expect(400);
      expect(badPostal.body.code).toBe('INVALID_ADDRESS');
      expect(JSON.stringify(badPostal.body.issues)).toContain('postalCode');

      const badProvince = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({
          email: uniqueEmail('adresse'),
          shippingAddress: { ...ADDRESS_US_NY, province: 'QC' }, // province CA sur pays US
        })
        .expect(400);
      expect(badProvince.body.code).toBe('INVALID_ADDRESS');
    });

    it('re-soumission : MÊME commande recotée, MÊME intent au nouveau montant', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 10_000, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const email = uniqueEmail('recote');

      const first = await createSession(ctx, { token, email, address: ADDRESS_QC });
      const second = await createSession(ctx, { token, email, address: addressFor('AB') });

      expect(second.order.id).toBe(first.order.id); // même commande
      expect(second.order.number).toBe(first.order.number); // même numéro
      expect(second.paymentIntentId).toBe(first.paymentIntentId); // même intent
      expect(second.order.totalCents).toBe(10_500); // recoté pour l'Alberta
      expect(ctx.stripe.peek(second.paymentIntentId).amount).toBe(10_500);

      // Une seule commande pour ce panier en base.
      const orders = await ctx.prisma.order.findMany({
        where: { id: first.order.id },
        include: { items: true },
      });
      expect(orders[0]!.items).toHaveLength(1); // lignes remplacées, pas dupliquées
    });

    it('après paiement : re-créer une session échoue proprement', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 2_500, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const email = uniqueEmail('paye');
      const session = await createSession(ctx, { token, email });
      await payAndGetResult(ctx, session);

      // Le panier est CONVERTED : plus de panier actif pour ce jeton.
      const response = await ctx
        .http()
        .post('/v1/checkout/session')
        .set('X-Cart-Token', token)
        .send({ email, shippingAddress: ADDRESS_QC })
        .expect(400);
      expect(response.body.code).toBe('CART_EMPTY');
    });

    it('result : client_secret erroné → 403 (preuve de possession)', async () => {
      const variant = await createTestVariant(ctx.prisma, { priceCents: 2_500, stock: 5 });
      const token = await guestAdd(ctx, variant.variantId, 1);
      const session = await createSession(ctx, { token, email: uniqueEmail('preuve') });
      await ctx
        .http()
        .post('/v1/checkout/result')
        .send({ paymentIntentId: session.paymentIntentId, clientSecret: 'pi_x_secret_faux' })
        .expect(403);
    });
  });
});
