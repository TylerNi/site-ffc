import { type Locale } from '@ffc/core';
import { bearer, login, registerAndVerify, uniqueEmail } from './auth-helpers';
import {
  type CheckoutTestContext,
  createSession,
  createTestVariant,
  postWebhook,
  type SessionResponse,
  type TestVariant,
} from './checkout-helpers';
import { addressFor } from './checkout-helpers';

/**
 * Aides des e2e du cycle de vie des commandes (tâche 12) : produit une
 * commande PAYÉE appartenant à un compte connecté, prête pour les
 * transitions, remboursements, factures et courriels.
 *
 * La finalisation passe par le WEBHOOK signé `payment_intent.succeeded`
 * (traité inline et attendu en test) : au retour, la commande est PAID, la
 * facture est générée et le courriel de confirmation est dans l'outbox.
 */
export interface PaidOrder {
  order: SessionResponse['order'];
  variant: TestVariant;
  email: string;
  accessToken: string;
  userId: string;
  paymentIntentId: string;
}

export async function paidOrderForUser(
  ctx: CheckoutTestContext,
  params: {
    priceCents?: number;
    stock?: number;
    quantity?: number;
    province?: string;
    locale?: Locale;
  } = {},
): Promise<PaidOrder> {
  const email = uniqueEmail('cmd');
  await registerAndVerify(ctx, email);
  const auth = await login(ctx, email);
  const token = auth.accessToken!;

  const variant = await createTestVariant(ctx.prisma, {
    priceCents: params.priceCents ?? 4_500,
    stock: params.stock ?? 5,
  });

  await ctx
    .http()
    .post('/v1/cart/items')
    .set('Authorization', bearer(token))
    .send({ variantId: variant.variantId, quantity: params.quantity ?? 1 })
    .expect(200);

  const session = await createSession(ctx, {
    bearer: token,
    address: addressFor(params.province ?? 'QC'),
    extra: params.locale ? { locale: params.locale } : {},
  });

  ctx.stripe.confirm(session.paymentIntentId, 'success');
  const intent = ctx.stripe.peek(session.paymentIntentId);
  await postWebhook(ctx, 'payment_intent.succeeded', intent);

  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
  return {
    order: session.order,
    variant,
    email,
    accessToken: token,
    userId: user.id,
    paymentIntentId: session.paymentIntentId,
  };
}

/** Quantité en main d'une variante (assertions de restock). */
export async function stockOnHand(ctx: CheckoutTestContext, variantId: string): Promise<number> {
  const level = await ctx.prisma.inventoryLevel.findUniqueOrThrow({ where: { variantId } });
  return level.quantityOnHand;
}
