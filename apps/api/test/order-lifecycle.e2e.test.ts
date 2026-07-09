import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createUserInDb, login } from './auth-helpers';
import { createCheckoutTestApp, type CheckoutTestContext } from './checkout-helpers';
import { paidOrderForUser, stockOnHand } from './order-helpers';
import { OrderLifecycleService } from '../src/modules/orders/lifecycle/order-lifecycle.service';

describe('cycle de vie des commandes (tâche 12)', () => {
  let ctx: CheckoutTestContext;
  let lifecycle: OrderLifecycleService;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
    lifecycle = ctx.app.get(OrderLifecycleService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('cycle complet payée → préparation → expédiée → livrée, historisé avec acteurs', async () => {
    const paid = await paidOrderForUser(ctx, { quantity: 1, stock: 4 });
    const admin = await createUserInDb(ctx, { role: 'ADMIN' });

    await lifecycle.markProcessing(paid.order.id, { type: 'admin', userId: admin.user.id });
    await lifecycle.markShipped(
      paid.order.id,
      { type: 'admin', userId: admin.user.id },
      { carrier: 'Postes Canada', trackingNumber: 'CP123', trackingUrl: 'https://track/CP123' },
    );
    await lifecycle.markDelivered(paid.order.id); // acteur système

    const detail = await ctx
      .http()
      .get(`/v1/me/orders/${paid.order.id}`)
      .set('Authorization', bearer(paid.accessToken))
      .expect(200);

    expect(detail.body.status).toBe('DELIVERED');
    const timeline = detail.body.timeline as Array<{ status: string; actor: string; at: string }>;
    const actorFor = (status: string): string | undefined =>
      timeline.find((e) => e.status === status)?.actor;
    expect(actorFor('PENDING')).toBe('system');
    expect(actorFor('PAID')).toBe('system');
    expect(actorFor('PROCESSING')).toBe('admin');
    expect(actorFor('SHIPPED')).toBe('admin');
    expect(actorFor('DELIVERED')).toBe('system');
    // Chaque événement est horodaté et l'ordre est croissant.
    const times = timeline.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // Courriels d'expédition et de livraison partis dans la bonne langue.
    const outbox = ctx.mail.outbox.filter((m) => m.to === paid.email);
    expect(outbox.some((m) => m.templateKey === 'order_shipped')).toBe(true);
    expect(outbox.some((m) => m.templateKey === 'order_delivered')).toBe(true);
  });

  it('refuse un saut illégal (payée → livrée)', async () => {
    const paid = await paidOrderForUser(ctx);
    await expect(lifecycle.markDelivered(paid.order.id)).rejects.toMatchObject({
      response: { code: 'ILLEGAL_TRANSITION' },
    });
  });

  it('transition idempotente (rejouer PROCESSING ne duplique pas l’historique)', async () => {
    const paid = await paidOrderForUser(ctx);
    await lifecycle.markProcessing(paid.order.id);
    await lifecycle.markProcessing(paid.order.id); // déjà PROCESSING → no-op
    const count = await ctx.prisma.orderStatusHistory.count({
      where: { orderId: paid.order.id, toStatus: 'PROCESSING' },
    });
    expect(count).toBe(1);
  });

  describe('« Mes commandes »', () => {
    it('liste et détail limités au compte, taxes ventilées et adresse présentes', async () => {
      const paid = await paidOrderForUser(ctx, { province: 'QC', priceCents: 5_000 });

      const list = await ctx
        .http()
        .get('/v1/me/orders')
        .set('Authorization', bearer(paid.accessToken))
        .expect(200);
      const found = (
        list.body.items as Array<{ id: string; hasInvoice: boolean; canCancel: boolean }>
      ).find((o) => o.id === paid.order.id);
      expect(found).toBeDefined();
      expect(found!.hasInvoice).toBe(true);
      expect(found!.canCancel).toBe(true);

      const detail = await ctx
        .http()
        .get(`/v1/me/orders/${paid.order.id}`)
        .set('Authorization', bearer(paid.accessToken))
        .expect(200);
      expect(detail.body.taxGstCents).toBeGreaterThan(0);
      expect(detail.body.taxQstCents).toBeGreaterThan(0);
      expect(detail.body.shippingAddress.province).toBe('QC');
      expect(detail.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    });

    it('interdit de voir la commande d’un autre compte (404)', async () => {
      const paid = await paidOrderForUser(ctx);
      const other = await createUserInDb(ctx);
      const auth = await login(ctx, other.email);
      await ctx
        .http()
        .get(`/v1/me/orders/${paid.order.id}`)
        .set('Authorization', bearer(auth.accessToken))
        .expect(404);
    });
  });

  describe('annulation par le client', () => {
    it('avant expédition : remboursement + restock + note de crédit + courriel', async () => {
      const paid = await paidOrderForUser(ctx, { quantity: 2, stock: 5, priceCents: 3_000 });
      expect(await stockOnHand(ctx, paid.variant.variantId)).toBe(3); // 5 − 2 vendus

      const res = await ctx
        .http()
        .post(`/v1/me/orders/${paid.order.id}/cancel`)
        .set('Authorization', bearer(paid.accessToken))
        .expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.refundAmountCents).toBe(paid.order.totalCents);

      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
      expect(order.status).toBe('CANCELLED');

      // Remboursement Stripe réel (faux mode test) intégral.
      const refunds = await ctx.prisma.refund.findMany({ where: { orderId: paid.order.id } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.amountCents).toBe(paid.order.totalCents);
      expect(refunds[0]!.status).toBe('SUCCEEDED');

      // Restock : les unités reviennent en inventaire.
      expect(await stockOnHand(ctx, paid.variant.variantId)).toBe(5);

      // Note de crédit (série CRN) reliée au remboursement.
      const creditNote = await ctx.prisma.invoice.findUnique({
        where: { refundId: refunds[0]!.id },
      });
      expect(creditNote?.kind).toBe('CREDIT_NOTE');
      expect(creditNote?.number).toMatch(/^CRN-\d{4}-\d{6}$/);
      expect(creditNote?.totalCents).toBe(paid.order.totalCents);

      // Courriel d'annulation.
      expect(
        ctx.mail.outbox.some((m) => m.to === paid.email && m.templateKey === 'order_cancelled'),
      ).toBe(true);
    });

    it('rejoué : une seule annulation, un seul remboursement', async () => {
      const paid = await paidOrderForUser(ctx, { quantity: 1, stock: 3 });
      await ctx
        .http()
        .post(`/v1/me/orders/${paid.order.id}/cancel`)
        .set('Authorization', bearer(paid.accessToken))
        .expect(200);
      const second = await ctx
        .http()
        .post(`/v1/me/orders/${paid.order.id}/cancel`)
        .set('Authorization', bearer(paid.accessToken))
        .expect(200);
      expect(second.body.status).toBe('CANCELLED');

      const refunds = await ctx.prisma.refund.findMany({ where: { orderId: paid.order.id } });
      expect(refunds).toHaveLength(1);
    });

    it('après expédition : annulation refusée (409)', async () => {
      const paid = await paidOrderForUser(ctx);
      await lifecycle.markProcessing(paid.order.id);
      await lifecycle.markShipped(paid.order.id);
      const res = await ctx
        .http()
        .post(`/v1/me/orders/${paid.order.id}/cancel`)
        .set('Authorization', bearer(paid.accessToken))
        .expect(409);
      expect(res.body.code).toBe('NOT_CANCELLABLE');
    });
  });
});
