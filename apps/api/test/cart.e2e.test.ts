import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, login, registerAndVerify, uniqueEmail } from './auth-helpers';
import {
  type CheckoutTestContext,
  createCheckoutTestApp,
  createTestVariant,
  guestAdd,
} from './checkout-helpers';

/**
 * API panier (tâche 11) : invité + compte, revalidation serveur à chaque
 * opération, retrait propre des produits dépubliés/épuisés, messages clairs.
 */
describe('panier — invité et compte, revalidation serveur', () => {
  let ctx: CheckoutTestContext;

  beforeAll(async () => {
    ctx = await createCheckoutTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('première addition invité : panier créé, jeton émis une seule fois, haché en base', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 1999, stock: 10 });
    const response = await ctx
      .http()
      .post('/v1/cart/items')
      .send({ variantId: variant.variantId, quantity: 2 })
      .expect(200);

    const token = response.body.guestCartToken as string;
    expect(token).toBeTruthy();
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].quantity).toBe(2);
    expect(response.body.subtotalCents).toBe(3998);

    // Jeton jamais stocké en clair.
    expect(await ctx.prisma.cart.findFirst({ where: { guestToken: token } })).toBeNull();

    // Deuxième ajout avec le jeton : quantités additionnées, PAS de nouveau jeton.
    const second = await ctx
      .http()
      .post('/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId: variant.variantId, quantity: 1 })
      .expect(200);
    expect(second.body.guestCartToken).toBeUndefined();
    expect(second.body.items[0].quantity).toBe(3);
  });

  it('les prix et totaux viennent de la base, jamais du client', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 1099, stock: 5 });
    // Le client tente d'imposer un prix — champ inconnu, silencieusement ignoré.
    const response = await ctx
      .http()
      .post('/v1/cart/items')
      .send({ variantId: variant.variantId, quantity: 1, unitPriceCents: 1 })
      .expect(200);
    expect(response.body.items[0].unitPriceCents).toBe(1099);
    expect(response.body.subtotalCents).toBe(1099);
  });

  it('ajout au-delà du stock : 409 INSUFFICIENT_STOCK avec la quantité disponible', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 999, stock: 3 });
    const response = await ctx
      .http()
      .post('/v1/cart/items')
      .send({ variantId: variant.variantId, quantity: 4 })
      .expect(409);
    expect(response.body.code).toBe('INSUFFICIENT_STOCK');
    expect(response.body.availableQuantity).toBe(3);
  });

  it('produit inconnu : 404 ; produit dépublié : 409 UNAVAILABLE', async () => {
    await ctx
      .http()
      .post('/v1/cart/items')
      .send({ variantId: '00000000-0000-4000-8999-000000000001', quantity: 1 })
      .expect(404);

    const variant = await createTestVariant(ctx.prisma, { priceCents: 999, stock: 3 });
    await ctx.prisma.product.update({
      where: { id: variant.productId },
      data: { status: 'ARCHIVED' },
    });
    const response = await ctx
      .http()
      .post('/v1/cart/items')
      .send({ variantId: variant.variantId, quantity: 1 })
      .expect(409);
    expect(response.body.code).toBe('UNAVAILABLE');
  });

  it('mise à jour et retrait de ligne', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 1500, stock: 10 });
    const token = await guestAdd(ctx, variant.variantId, 1);

    const updated = await ctx
      .http()
      .patch(`/v1/cart/items/${variant.variantId}`)
      .set('X-Cart-Token', token)
      .send({ quantity: 4 })
      .expect(200);
    expect(updated.body.items[0].quantity).toBe(4);

    const removed = await ctx
      .http()
      .delete(`/v1/cart/items/${variant.variantId}`)
      .set('X-Cart-Token', token)
      .expect(200);
    expect(removed.body.items).toHaveLength(0);
    expect(removed.body.subtotalCents).toBe(0);
  });

  it('produit dépublié APRÈS l’ajout : retiré proprement, signalé une seule fois', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 2500, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 2);

    await ctx.prisma.product.update({
      where: { id: variant.productId },
      data: { status: 'ARCHIVED' },
    });

    const first = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(first.body.items).toHaveLength(0);
    expect(first.body.changes.removed).toHaveLength(1);
    expect(first.body.changes.removed[0]).toMatchObject({
      sku: variant.sku,
      reason: 'UNAVAILABLE',
    });

    // Le panier est réconcilié : plus aucun écart au second passage.
    const second = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(second.body.changes.removed).toHaveLength(0);
  });

  it('produit épuisé entre l’ajout et la lecture : retiré avec OUT_OF_STOCK', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 2500, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 2);

    await ctx.prisma.inventoryLevel.update({
      where: { variantId: variant.variantId },
      data: { quantityOnHand: 0 },
    });

    const view = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(view.body.items).toHaveLength(0);
    expect(view.body.changes.removed[0].reason).toBe('OUT_OF_STOCK');
  });

  it('stock devenu inférieur à la quantité : rabattue au restant, signalé', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 2500, stock: 10 });
    const token = await guestAdd(ctx, variant.variantId, 6);

    await ctx.prisma.inventoryLevel.update({
      where: { variantId: variant.variantId },
      data: { quantityOnHand: 2 },
    });

    const view = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(view.body.items[0].quantity).toBe(2);
    expect(view.body.changes.adjusted[0]).toMatchObject({ fromQuantity: 6, toQuantity: 2 });
  });

  it('prix modifié depuis l’ajout : nouveau prix appliqué, changement signalé une fois', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 1000, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 1);

    await ctx.prisma.productVariant.update({
      where: { id: variant.variantId },
      data: { priceCents: 1250 },
    });

    const first = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(first.body.items[0].unitPriceCents).toBe(1250);
    expect(first.body.changes.priceChanged[0]).toMatchObject({ fromCents: 1000, toCents: 1250 });

    const second = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(second.body.changes.priceChanged).toHaveLength(0);
  });

  it('jeton invité inconnu ou expiré : panier vide, jamais d’erreur', async () => {
    const unknown = await ctx.http().get('/v1/cart').set('X-Cart-Token', 'jeton-bidon').expect(200);
    expect(unknown.body.id).toBeNull();
    expect(unknown.body.items).toHaveLength(0);

    const variant = await createTestVariant(ctx.prisma, { priceCents: 999, stock: 5 });
    const token = await guestAdd(ctx, variant.variantId, 1);
    const cart = await ctx.prisma.cart.findFirstOrThrow({
      where: { items: { some: { variantId: variant.variantId } } },
    });
    await ctx.prisma.cart.update({
      where: { id: cart.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(expired.body.items).toHaveLength(0);

    // Ré-ajout avec le jeton mort : nouveau panier, NOUVEAU jeton (auto-guérison).
    const readd = await ctx
      .http()
      .post('/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId: variant.variantId, quantity: 1 })
      .expect(200);
    expect(readd.body.guestCartToken).toBeTruthy();
    expect(readd.body.guestCartToken).not.toBe(token);
  });

  it('panier de compte via Bearer ; un Bearer invalide reste un 401 franc', async () => {
    const email = uniqueEmail('panier-compte');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const variant = await createTestVariant(ctx.prisma, { priceCents: 3000, stock: 5 });

    const added = await ctx
      .http()
      .post('/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ variantId: variant.variantId, quantity: 1 })
      .expect(200);
    expect(added.body.guestCartToken).toBeUndefined(); // pas de jeton pour un compte

    const view = await ctx
      .http()
      .get('/v1/cart')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);
    expect(view.body.items).toHaveLength(1);

    await ctx.http().get('/v1/cart').set('Authorization', 'Bearer jeton-invalide').expect(401);
  });

  it('le panier persiste entre les visites (jeton retrouvé plus tard)', async () => {
    const variant = await createTestVariant(ctx.prisma, { priceCents: 1234, stock: 9 });
    const token = await guestAdd(ctx, variant.variantId, 3);

    // « Nouvelle visite » : seul le jeton est présenté.
    const view = await ctx.http().get('/v1/cart').set('X-Cart-Token', token).expect(200);
    expect(view.body.items[0]).toMatchObject({ sku: variant.sku, quantity: 3 });
    expect(view.body.items[0].nameFr).toContain('Filtre de test');
    expect(view.body.items[0].nameEn).toContain('Test filter');
  });
});
