import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutTestApp, type CheckoutTestContext } from './checkout-helpers';
import { paidOrderForUser, stockOnHand } from './order-helpers';
import { RefundService } from '../src/modules/orders/refunds/refund.service';

const ADMIN = { type: 'admin', userId: null } as const;

describe('service de remboursement (tâche 12)', () => {
  let ctx: CheckoutTestContext;
  let refunds: RefundService;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
    refunds = ctx.app.get(RefundService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('remboursement total : commande REFUNDED, note de crédit, courriel', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 4_000, quantity: 1 });

    const result = await refunds.refund(paid.order.id, {
      restock: false,
      reason: 'geste commercial',
      actor: ADMIN,
    });
    expect(result.fullyRefunded).toBe(true);
    expect(result.amountCents).toBe(paid.order.totalCents);
    expect(result.orderStatus).toBe('REFUNDED');

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('REFUNDED');
    const payment = await ctx.prisma.payment.findFirstOrThrow({
      where: { orderId: paid.order.id, provider: 'STRIPE' },
    });
    expect(payment.status).toBe('REFUNDED');

    const creditNote = await ctx.prisma.invoice.findUniqueOrThrow({
      where: { refundId: result.refundId },
    });
    expect(creditNote.kind).toBe('CREDIT_NOTE');
    expect(creditNote.totalCents).toBe(paid.order.totalCents);

    expect(
      ctx.mail.outbox.some((m) => m.to === paid.email && m.templateKey === 'order_refunded'),
    ).toBe(true);
  });

  it('remboursement partiel PAR MONTANT : PARTIALLY_REFUNDED, taxes ventilées cohérentes', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 10_000, quantity: 1 });
    const amount = 2_500;

    const result = await refunds.refund(paid.order.id, {
      amountCents: amount,
      restock: false,
      reason: 'ajustement',
      actor: ADMIN,
    });
    expect(result.amountCents).toBe(amount);
    expect(result.fullyRefunded).toBe(false);
    expect(result.orderStatus).toBe('PARTIALLY_REFUNDED');

    const creditNote = await ctx.prisma.invoice.findUniqueOrThrow({
      where: { refundId: result.refundId },
    });
    expect(creditNote.totalCents).toBe(amount);
    // La ventilation (sous-total net + livraison + taxes) somme au montant remboursé.
    const parts =
      creditNote.subtotalCents +
      creditNote.shippingCents +
      creditNote.taxGstCents +
      creditNote.taxQstCents +
      creditNote.taxHstCents +
      creditNote.taxPstCents;
    expect(parts).toBe(amount);
  });

  it('remboursement PAR LIGNES avec restock : montant = total des lignes, stock rétabli', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 6_000, quantity: 2, stock: 10 });
    expect(await stockOnHand(ctx, paid.variant.variantId)).toBe(8);

    const items = await ctx.prisma.orderItem.findMany({ where: { orderId: paid.order.id } });
    const line = items[0]!;

    const result = await refunds.refund(paid.order.id, {
      lineItemIds: [line.id],
      restock: true,
      reason: 'article défectueux',
      actor: ADMIN,
    });
    expect(result.amountCents).toBe(line.totalCents);
    // Les 2 unités de la ligne reviennent en stock.
    expect(await stockOnHand(ctx, paid.variant.variantId)).toBe(10);
    const movements = await ctx.prisma.inventoryMovement.findMany({
      where: { orderId: paid.order.id, type: 'RETURN' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity).toBe(2);
  });

  it('rejeu (même clé d’idempotence) : un seul remboursement, aucun second effet', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 10_000, quantity: 1, stock: 5 });
    const request = {
      amountCents: 1_500, // partiel : la commande reste remboursable ensuite
      restock: false,
      reason: 'rejeu',
      actor: ADMIN,
      idempotencyKey: `test:refund:${paid.order.id}`,
    } as const;

    const first = await refunds.refund(paid.order.id, request);
    expect(first.alreadyDone).toBe(false);
    const second = await refunds.refund(paid.order.id, request);
    expect(second.alreadyDone).toBe(true);
    expect(second.refundId).toBe(first.refundId);

    // Un seul remboursement et une seule note de crédit malgré le rejeu.
    const rows = await ctx.prisma.refund.findMany({ where: { orderId: paid.order.id } });
    expect(rows).toHaveLength(1);
    const creditNotes = await ctx.prisma.invoice.findMany({
      where: { orderId: paid.order.id, kind: 'CREDIT_NOTE' },
    });
    expect(creditNotes).toHaveLength(1);
  });

  it('refuse un remboursement supérieur au restant', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 3_000, quantity: 1 });
    await expect(
      refunds.refund(paid.order.id, {
        amountCents: paid.order.totalCents + 1,
        restock: false,
        reason: 'trop',
        actor: ADMIN,
      }),
    ).rejects.toBeDefined();
  });
});
