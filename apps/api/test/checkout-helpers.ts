import { randomUUID } from 'node:crypto';
import { type PrismaService } from '../src/database';
import { type CheckoutAddressDto } from '../src/modules/orders/checkout/dto/checkout.dto';
import { type AuthTestContext, createTestApp, type CreateTestAppOptions } from './auth-helpers';
import { FakeStripeService } from './fakes/fake-stripe';

/**
 * Aides partagées des e2e panier/checkout/webhooks (tâche 11) : app avec
 * faux Stripe, produits de test au prix maîtrisé, adresses par province.
 */

export interface CheckoutTestContext extends AuthTestContext {
  stripe: FakeStripeService;
}

export async function createCheckoutTestApp(
  options: CreateTestAppOptions = {},
): Promise<CheckoutTestContext> {
  const stripe = new FakeStripeService();
  const ctx = await createTestApp({ ...options, stripe });
  return { ...ctx, stripe };
}

/* ------------------------------- Adresses -------------------------------- */

export const ADDRESS_QC: CheckoutAddressDto = {
  firstName: 'Marie',
  lastName: 'Tremblay',
  line1: '1234, rue Sainte-Catherine Est',
  city: 'Montréal',
  province: 'QC',
  postalCode: 'H2L 2G8',
  country: 'CA',
};

export function addressFor(province: string): CheckoutAddressDto {
  const samples: Record<string, Partial<CheckoutAddressDto>> = {
    QC: {},
    ON: { city: 'Toronto', province: 'ON', postalCode: 'M5V 2T6', line1: '1 Front St W' },
    NS: { city: 'Halifax', province: 'NS', postalCode: 'B3J 3N8', line1: '5251 Duke St' },
    AB: { city: 'Calgary', province: 'AB', postalCode: 'T2P 1J9', line1: '101 9 Ave SW' },
    BC: { city: 'Vancouver', province: 'BC', postalCode: 'V6B 4Y8', line1: '800 Robson St' },
    MB: { city: 'Winnipeg', province: 'MB', postalCode: 'R3C 0V8', line1: '1 Portage Ave' },
  };
  const sample = samples[province];
  if (!sample) throw new Error(`Adresse de test manquante pour ${province}`);
  return { ...ADDRESS_QC, ...sample };
}

export const ADDRESS_US_NY: CheckoutAddressDto = {
  firstName: 'John',
  lastName: 'Doe',
  line1: '1 Main St',
  city: 'Buffalo',
  province: 'NY',
  postalCode: '14201',
  country: 'US',
};

/* ---------------------------- Produits de test --------------------------- */

export interface TestVariant {
  variantId: string;
  productId: string;
  sku: string;
  priceCents: number;
}

/**
 * Produit ACTIF dédié au test : prix exact maîtrisé (assertions de taxes
 * au cent), stock contrôlé. Marque du seed réutilisée. Taille nominale
 * « 19x27x1 » VOLONTAIREMENT hors seed : la base de test est partagée avec
 * la suite catalogue (tâche 06) qui fait des assertions exactes sur les
 * tailles seedées — les produits de checkout ne doivent pas les polluer.
 */
export async function createTestVariant(
  prisma: PrismaService,
  params: { priceCents: number; stock: number; skuPrefix?: string },
): Promise<TestVariant> {
  const suffix = randomUUID().slice(0, 8);
  const sku = `${params.skuPrefix ?? 'TST'}-${suffix}`.toUpperCase();
  const brand = await prisma.brand.findFirstOrThrow();

  const product = await prisma.product.create({
    data: {
      brandId: brand.id,
      status: 'ACTIVE',
      translations: {
        create: [
          { locale: 'fr', name: `Filtre de test ${suffix}`, slug: `filtre-test-${suffix}` },
          { locale: 'en', name: `Test filter ${suffix}`, slug: `test-filter-${suffix}` },
        ],
      },
      variants: {
        create: {
          sku,
          nominalLabel: '19x27x1',
          nominalWidthIn: 19,
          nominalHeightIn: 27,
          nominalDepthIn: 1,
          actualWidthIn: 18.75,
          actualHeightIn: 26.75,
          actualDepthIn: 0.75,
          merv: 11,
          packSize: 1,
          priceCents: params.priceCents,
          currency: 'CAD',
          isActive: true,
          inventoryLevel: { create: { quantityOnHand: params.stock } },
        },
      },
    },
    include: { variants: true },
  });

  const variant = product.variants[0]!;
  return { variantId: variant.id, productId: product.id, sku, priceCents: params.priceCents };
}

/* ------------------------------ Panier invité ---------------------------- */

/** Ajoute au panier invité par l'API ; retourne le jeton (créé au 1er ajout). */
export async function guestAdd(
  ctx: CheckoutTestContext,
  variantId: string,
  quantity: number,
  token?: string,
): Promise<string> {
  const request = ctx.http().post('/v1/cart/items').send({ variantId, quantity });
  if (token) void request.set('X-Cart-Token', token);
  const response = await request.expect(200);
  const issued = (response.body.guestCartToken as string | undefined) ?? token;
  if (!issued) throw new Error('Aucun jeton de panier émis');
  return issued;
}

/* ------------------------------- Checkout -------------------------------- */

export interface SessionResponse {
  clientSecret: string;
  paymentIntentId: string;
  order: {
    id: string;
    number: string;
    email: string;
    subtotalCents: number;
    discountCents: number;
    shippingCents: number;
    taxGstCents: number;
    taxQstCents: number;
    taxHstCents: number;
    taxPstCents: number;
    totalTaxCents: number;
    totalCents: number;
    couponCode: string | null;
    lines: Array<{ sku: string; quantity: number; taxCents: number; totalCents: number }>;
  };
}

export async function createSession(
  ctx: CheckoutTestContext,
  params: {
    token?: string;
    bearer?: string;
    email?: string;
    address?: CheckoutAddressDto;
    couponCode?: string;
    extra?: Record<string, unknown>;
    expect?: number;
  },
): Promise<SessionResponse> {
  const request = ctx.http().post('/v1/checkout/session');
  if (params.token) void request.set('X-Cart-Token', params.token);
  if (params.bearer) void request.set('Authorization', `Bearer ${params.bearer}`);
  const response = await request
    .send({
      email: params.email,
      shippingAddress: params.address ?? ADDRESS_QC,
      couponCode: params.couponCode,
      ...params.extra,
    })
    .expect(params.expect ?? 200);
  return response.body as SessionResponse;
}

/** Confirme le paiement (faux Stripe) puis interroge /checkout/result. */
export async function payAndGetResult(
  ctx: CheckoutTestContext,
  session: SessionResponse,
  outcome: 'success' | 'declined' | 'requires_action' = 'success',
): Promise<Record<string, unknown>> {
  ctx.stripe.confirm(session.paymentIntentId, outcome);
  const response = await ctx
    .http()
    .post('/v1/checkout/result')
    .send({ paymentIntentId: session.paymentIntentId, clientSecret: session.clientSecret })
    .expect(200);
  return response.body as Record<string, unknown>;
}

/** Publie un événement webhook SIGNÉ ; retourne l'id d'événement (rejeu). */
export async function postWebhook(
  ctx: CheckoutTestContext,
  type: string,
  object: unknown,
  eventId?: string,
): Promise<{ eventId: string; body: Record<string, unknown> }> {
  const { payload, signature, eventId: id } = ctx.stripe.signedEvent(type, object, eventId);
  const response = await ctx
    .http()
    .post('/v1/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('content-type', 'application/json')
    .send(payload)
    .expect(200);
  return { eventId: id, body: response.body as Record<string, unknown> };
}
