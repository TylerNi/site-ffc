import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './auth-helpers';
import {
  createCheckoutTestApp,
  createSession,
  createTestVariant,
  guestAdd,
  postWebhook,
  type CheckoutTestContext,
} from './checkout-helpers';
import { paidOrderForUser } from './order-helpers';
import { InvoiceService } from '../src/modules/orders/invoices/invoice.service';

describe('courriels transactionnels de commande (tâche 12)', () => {
  let ctx: CheckoutTestContext;
  let invoices: InvoiceService;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
    invoices = ctx.app.get(InvoiceService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('confirmation dans la langue du client (fr / en) avec lien de facture et adresse au pied', async () => {
    const fr = await paidOrderForUser(ctx, { locale: 'fr' });
    const en = await paidOrderForUser(ctx, { locale: 'en' });

    const frMail = ctx.mail.outbox.find(
      (m) => m.to === fr.email && m.templateKey === 'order_confirmation',
    );
    const enMail = ctx.mail.outbox.find(
      (m) => m.to === en.email && m.templateKey === 'order_confirmation',
    );

    expect(frMail?.subject).toContain('Confirmation de commande');
    expect(enMail?.subject).toContain('Order confirmation');
    // Lien de facture présent.
    expect(frMail?.variables.invoiceUrl).toContain('/v1/invoices/');
    // Adresse physique dans le pied du gabarit HTML (courriel transactionnel).
    expect(frMail?.html).toContain('Sainte-Catherine');
    expect(frMail?.html).toContain('Filtration Montréal');
  });

  it('job rejoué → un seul courriel de confirmation (idempotence)', async () => {
    const paid = await paidOrderForUser(ctx);
    // Rejoue la génération de facture → tente de renvoyer la confirmation.
    await invoices.generateForOrder(paid.order.id);
    await invoices.generateForOrder(paid.order.id);

    const confirmations = ctx.mail.outbox.filter(
      (m) => m.to === paid.email && m.templateKey === 'order_confirmation',
    );
    expect(confirmations).toHaveLength(1);

    // Trace unique dans notifications, avec clé d'idempotence.
    const notifs = await ctx.prisma.notification.findMany({
      where: { orderId: paid.order.id, templateKey: 'order_confirmation' },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.status).toBe('SENT');
    expect(notifs[0]!.idempotencyKey).toBe(`order_confirmation:${paid.order.id}`);
    expect(notifs[0]!.category).toBe('TRANSACTIONAL');
  });

  it('paiement échoué : courriel « paiement échoué », rejeu du webhook → un seul courriel', async () => {
    const email = uniqueEmail('echec');
    const variant = await createTestVariant(ctx.prisma, { priceCents: 3_000, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 1);
    const session = await createSession(ctx, { token, email, extra: { locale: 'en' } });

    ctx.stripe.confirm(session.paymentIntentId, 'declined');
    const intent = ctx.stripe.peek(session.paymentIntentId);
    // Même événement joué deux fois (rejeu) → un seul courriel.
    await postWebhook(ctx, 'payment_intent.payment_failed', intent, 'evt_failed_dedupe');
    await postWebhook(ctx, 'payment_intent.payment_failed', intent, 'evt_failed_dedupe');

    const failedMails = ctx.mail.outbox.filter(
      (m) => m.to === email && m.templateKey === 'order_payment_failed',
    );
    expect(failedMails).toHaveLength(1);
    expect(failedMails[0]!.subject).toContain('Payment failed'); // locale en
  });
});
