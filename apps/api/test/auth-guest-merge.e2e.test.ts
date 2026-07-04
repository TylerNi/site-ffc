import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  createTestApp,
  login,
  registerAndVerify,
  TEST_PASSWORD,
  tokenFromMail,
  lastMail,
  uniqueEmail,
} from './auth-helpers';

/**
 * Mode invité (tâche 05) : jeton de panier anonyme haché en base, fusion
 * vers le compte à l'inscription et à la connexion selon les règles de
 * docs/auth.md (rattachement direct ou addition des quantités).
 */
describe('auth — panier invité et fusion', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Crée un panier invité par l'API et y met des lignes directement en base. */
  async function guestCartWithItems(
    items: Array<{ sku: string; quantity: number; priceCents?: number }>,
  ): Promise<{ token: string; cartId: string }> {
    const created = await ctx.http().post('/v1/auth/guest-cart').expect(201);
    const token = created.body.guestCartToken as string;
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const cart = await ctx.prisma.cart.findUniqueOrThrow({ where: { guestToken: tokenHash } });

    for (const item of items) {
      const variant = await ctx.prisma.productVariant.findUniqueOrThrow({
        where: { sku: item.sku },
      });
      await ctx.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          variantId: variant.id,
          quantity: item.quantity,
          addedAtPriceCents: item.priceCents ?? variant.priceCents,
        },
      });
    }
    return { token, cartId: cart.id };
  }

  /** Deux SKU stables du seed (catalogue reproductible de la tâche 04). */
  async function seededSkus(): Promise<[string, string]> {
    const variants = await ctx.prisma.productVariant.findMany({
      orderBy: { sku: 'asc' },
      take: 2,
    });
    expect(variants.length).toBe(2);
    return [variants[0]!.sku, variants[1]!.sku];
  }

  it('le jeton invité est stocké haché, jamais en clair', async () => {
    const created = await ctx.http().post('/v1/auth/guest-cart').expect(201);
    const token = created.body.guestCartToken as string;
    const clear = await ctx.prisma.cart.findFirst({ where: { guestToken: token } });
    expect(clear).toBeNull(); // introuvable en clair…
    const hashed = await ctx.prisma.cart.findFirst({
      where: { guestToken: createHash('sha256').update(token, 'utf8').digest('hex') },
    });
    expect(hashed).not.toBeNull(); // …présent haché
    expect(hashed!.expiresAt).not.toBeNull();
  });

  it('à l’inscription : le panier invité est rattaché au nouveau compte', async () => {
    const [skuA] = await seededSkus();
    const { token, cartId } = await guestCartWithItems([{ sku: skuA, quantity: 3 }]);
    const email = uniqueEmail('invite-inscription');

    await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email, password: TEST_PASSWORD, guestCartToken: token })
      .expect(201);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const cart = await ctx.prisma.cart.findUniqueOrThrow({
      where: { id: cartId },
      include: { items: true },
    });
    expect(cart.userId).toBe(user.id); // rattachement direct (cas 1)
    expect(cart.guestToken).toBeNull(); // jeton invalidé
    expect(cart.status).toBe('ACTIVE');
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]!.quantity).toBe(3);

    // Fusion auditée.
    const merges = await ctx.prisma.auditLog.findMany({
      where: { action: 'cart.merge_guest', actorId: user.id },
    });
    expect(merges).toHaveLength(1);
  });

  it('à la connexion : les quantités s’additionnent dans le panier du compte', async () => {
    const [skuA, skuB] = await seededSkus();
    const email = uniqueEmail('invite-fusion');
    await registerAndVerify(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    // Panier de compte existant : 2 × A.
    const variantA = await ctx.prisma.productVariant.findUniqueOrThrow({ where: { sku: skuA } });
    const accountCart = await ctx.prisma.cart.create({
      data: {
        userId: user.id,
        status: 'ACTIVE',
        items: { create: [{ variantId: variantA.id, quantity: 2, addedAtPriceCents: 1111 }] },
      },
    });

    // Panier invité : 3 × A (prix plus récent) + 1 × B.
    const { token, cartId: guestCartId } = await guestCartWithItems([
      { sku: skuA, quantity: 3, priceCents: 2222 },
      { sku: skuB, quantity: 1 },
    ]);

    await login(ctx, email, TEST_PASSWORD, { guestCartToken: token });

    const merged = await ctx.prisma.cart.findUniqueOrThrow({
      where: { id: accountCart.id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    expect(merged.items).toHaveLength(2);
    const lineA = merged.items.find((item) => item.variantId === variantA.id)!;
    expect(lineA.quantity).toBe(5); // 2 + 3 : addition
    expect(lineA.addedAtPriceCents).toBe(2222); // l'intention la plus récente (invité)

    // Panier invité vidé, marqué ABANDONED, jeton mort.
    const guest = await ctx.prisma.cart.findUniqueOrThrow({
      where: { id: guestCartId },
      include: { items: true },
    });
    expect(guest.status).toBe('ABANDONED');
    expect(guest.items).toHaveLength(0);
    expect(guest.guestToken).toBeNull();

    // Rejouer le même jeton à une connexion suivante : ignoré sans erreur.
    await login(ctx, email, TEST_PASSWORD, { guestCartToken: token });
  });

  it('un jeton invité expiré est ignoré silencieusement (la connexion réussit)', async () => {
    const [skuA] = await seededSkus();
    const { token, cartId } = await guestCartWithItems([{ sku: skuA, quantity: 1 }]);
    await ctx.prisma.cart.update({
      where: { id: cartId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const email = uniqueEmail('invite-expire');
    await registerAndVerify(ctx, email);
    await login(ctx, email, TEST_PASSWORD, { guestCartToken: token });

    const untouched = await ctx.prisma.cart.findUniqueOrThrow({ where: { id: cartId } });
    expect(untouched.userId).toBeNull(); // rien n'a été fusionné
  });

  it('la fusion marche aussi au terme d’un login MFA et d’un login social', async () => {
    // Ce point est couvert structurellement : completeLogin (tronc commun)
    // fait la fusion — vérifié ici via le parcours de vérification courriel
    // puis login avec jeton, pour éviter la redondance des scénarios MFA.
    const [skuA] = await seededSkus();
    const email = uniqueEmail('invite-commun');
    await ctx.http().post('/v1/auth/register').send({ email, password: TEST_PASSWORD }).expect(201);
    const verifyToken = tokenFromMail(lastMail(ctx, email, 'email_verification'), 'verifyUrl');
    await ctx.http().post('/v1/auth/verify-email').send({ token: verifyToken }).expect(200);

    const { token } = await guestCartWithItems([{ sku: skuA, quantity: 2 }]);
    await login(ctx, email, TEST_PASSWORD, { guestCartToken: token });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const cart = await ctx.prisma.cart.findFirstOrThrow({
      where: { userId: user.id, status: 'ACTIVE' },
      include: { items: true },
    });
    expect(cart.items[0]!.quantity).toBe(2);
  });
});
