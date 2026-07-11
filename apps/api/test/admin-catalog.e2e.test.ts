import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  adminLogin,
  type AuthTestContext,
  bearer,
  createTestApp,
  lastMail,
  makeAdminWithMfa,
} from './auth-helpers';
import { FakeRevalidationClient } from './fakes/fake-revalidation-client';
import {
  PRODUCT_IMAGE_STORAGE,
  type ProductImageStorage,
} from '../src/modules/admin/product-image-storage';

/**
 * Admin — catalogue et inventaire (tâche 10). Couvre les critères
 * d'acceptation :
 *   1. cycle complet créer → traduire → 2 images → prix/stock → publier,
 *      visible < 60 s via une revalidation ISR demandée (vitrine simulée) ;
 *   2. un ajustement sans motif est refusé ; l'historique montre acteur +
 *      motif + delta (la ligne `inventory_movements`) ;
 *   3. franchissement de seuil à la baisse → alerte courriel reçue ;
 *   4. un compte lecture_seule voit tout mais ne peut rien modifier.
 */
describe('admin — catalogue et inventaire (tâche 10)', () => {
  let ctx: AuthTestContext;
  let revalidation: FakeRevalidationClient;
  let brandId: string;

  beforeAll(async () => {
    revalidation = new FakeRevalidationClient();
    ctx = await createTestApp({ revalidation });
    brandId = (await ctx.prisma.brand.findFirstOrThrow()).id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function catalogueAdmin(): Promise<{
    admin: { id: string; email: string; password: string; recoveryCodes: string[] };
    token: string;
  }> {
    const admin = await makeAdminWithMfa(ctx, ['catalogue']);
    const token = await adminLogin(ctx, admin.email, admin.password, admin.recoveryCodes[0]!);
    return { admin, token };
  }

  const VARIANT_FIELDS = {
    nominalLabel: '16x25x1',
    nominalWidthIn: 15.75,
    nominalHeightIn: 24.75,
    nominalDepthIn: 0.75,
    actualWidthIn: 15.75,
    actualHeightIn: 24.75,
    actualDepthIn: 0.75,
  };

  /** Produit + variante minimale, prête pour les tests d'inventaire. */
  async function createVariantFixture(
    token: string,
  ): Promise<{ productId: string; variantId: string; sku: string }> {
    const suffix = randomUUID().slice(0, 8);
    const product = await ctx
      .http()
      .post('/v1/admin/products')
      .set('Authorization', bearer(token))
      .send({ brandId })
      .expect(201);
    const sku = `SKU-${suffix}`.toUpperCase();
    const variant = await ctx
      .http()
      .post(`/v1/admin/products/${product.body.id}/variants`)
      .set('Authorization', bearer(token))
      .send({ ...VARIANT_FIELDS, sku, priceCents: 1999 })
      .expect(201);
    return { productId: product.body.id as string, variantId: variant.body.id as string, sku };
  }

  /* ------------------------- Critère 1 : cycle complet ----------------------- */

  it('CRITÈRE 1 : créer → traduire → 2 images → prix/stock → publier (revalidation ISR demandée)', async () => {
    const { token } = await catalogueAdmin();
    const suffix = randomUUID().slice(0, 8);

    // 1. Créer (brouillon).
    const created = await ctx
      .http()
      .post('/v1/admin/products')
      .set('Authorization', bearer(token))
      .send({ brandId })
      .expect(201);
    const productId = created.body.id as string;
    expect(created.body.status).toBe('DRAFT');

    // 2. Traduire fr et en, côte à côte.
    const slugFr = `filtre-admin-test-${suffix}`;
    const slugEn = `admin-test-filter-${suffix}`;
    await ctx
      .http()
      .patch(`/v1/admin/products/${productId}/translations/fr`)
      .set('Authorization', bearer(token))
      .send({ name: 'Filtre test admin', slug: slugFr })
      .expect(200);
    const afterEn = await ctx
      .http()
      .patch(`/v1/admin/products/${productId}/translations/en`)
      .set('Authorization', bearer(token))
      .send({ name: 'Admin test filter', slug: slugEn })
      .expect(200);
    expect(afterEn.body.translations).toHaveLength(2);

    // 3. Téléverser 2 images (URL présignée → « upload » simulé → enregistrement).
    const storage = ctx.app.get<ProductImageStorage>(PRODUCT_IMAGE_STORAGE);
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const imageIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const presigned = await ctx
        .http()
        .post(`/v1/admin/products/${productId}/images/upload-url`)
        .set('Authorization', bearer(token))
        .send({ contentType: 'image/png' })
        .expect(201);
      expect(presigned.body.key).toContain(`product-images/${productId}/`);

      await storage.put(presigned.body.key as string, png);

      const registered = await ctx
        .http()
        .post(`/v1/admin/products/${productId}/images`)
        .set('Authorization', bearer(token))
        .send({ key: presigned.body.key, altFr: `Image ${i} fr`, altEn: `Image ${i} en` })
        .expect(201);
      expect(registered.body.width).toBe(40);
      imageIds.push(registered.body.id as string);
    }
    expect(imageIds).toHaveLength(2);

    // 4. Fixer prix et stock (variante + ajustement d'inventaire).
    const variant = await ctx
      .http()
      .post(`/v1/admin/products/${productId}/variants`)
      .set('Authorization', bearer(token))
      .send({ ...VARIANT_FIELDS, sku: `SKU-${suffix}`.toUpperCase(), priceCents: 2999 })
      .expect(201);
    const variantId = variant.body.id as string;

    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 25, reason: 'Réception initiale' })
      .expect(201);

    // 5. Publier → revalidation ISR de la vitrine (fr + en + liste).
    revalidation.calls.length = 0;
    const published = await ctx
      .http()
      .post(`/v1/admin/products/${productId}/publish`)
      .set('Authorization', bearer(token))
      .send({})
      .expect(200);
    expect(published.body.status).toBe('ACTIVE');
    expect(revalidation.calls).toHaveLength(1);
    expect(revalidation.calls[0]).toEqual(
      expect.arrayContaining(['products', `product:fr:${slugFr}`, `product:en:${slugEn}`]),
    );

    // Visible côté vitrine publique (catalogue tâche 06), sans redéploiement.
    const publicFr = await ctx
      .http()
      .get(`/v1/catalog/products/${slugFr}`)
      .query({ locale: 'fr' })
      .expect(200);
    expect(publicFr.body.slug).toBe(slugFr);
    expect(publicFr.body.images).toHaveLength(2);
    const publicEn = await ctx
      .http()
      .get(`/v1/catalog/products/${slugEn}`)
      .query({ locale: 'en' })
      .expect(200);
    expect(publicEn.body.slug).toBe(slugEn);

    // Dépublier / archiver redemandent aussi une revalidation (pas seulement publier).
    revalidation.calls.length = 0;
    await ctx
      .http()
      .post(`/v1/admin/products/${productId}/archive`)
      .set('Authorization', bearer(token))
      .send({})
      .expect(200);
    expect(revalidation.calls).toHaveLength(1);
  });

  it('publier un produit sans traduction ou sans variante est refusé', async () => {
    const { token } = await catalogueAdmin();
    const created = await ctx
      .http()
      .post('/v1/admin/products')
      .set('Authorization', bearer(token))
      .send({ brandId })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/admin/products/${created.body.id}/publish`)
      .set('Authorization', bearer(token))
      .send({})
      .expect(400);
  });

  it('duplique un produit comme gabarit : slugs et SKU renommés, aucune collision', async () => {
    const { token } = await catalogueAdmin();
    const { productId, sku: originalSku } = await createVariantFixture(token);
    const suffix = randomUUID().slice(0, 8);
    await ctx
      .http()
      .patch(`/v1/admin/products/${productId}/translations/fr`)
      .set('Authorization', bearer(token))
      .send({ name: 'Gabarit', slug: `gabarit-${suffix}` })
      .expect(200);

    const duplicated = await ctx
      .http()
      .post(`/v1/admin/products/${productId}/duplicate`)
      .set('Authorization', bearer(token))
      .expect(201);
    expect(duplicated.body.id).not.toBe(productId);
    expect(duplicated.body.status).toBe('DRAFT');
    expect(duplicated.body.translations[0].slug).not.toBe(`gabarit-${suffix}`);
    expect(duplicated.body.variants).toHaveLength(1);
    expect(duplicated.body.variants[0].sku).not.toBe(originalSku);

    // Le produit original garde bien son propre SKU/slug (aucun effet de bord).
    const original = await ctx
      .http()
      .get(`/v1/admin/products/${productId}`)
      .set('Authorization', bearer(token))
      .expect(200);
    expect(original.body.variants[0].sku).toBe(originalSku);
  });

  /* ---------------------- Critère 2 : ajustements tracés --------------------- */

  it('CRITÈRE 2 : un ajustement sans motif est refusé ; l’historique montre acteur + motif + delta', async () => {
    const { token, admin } = await catalogueAdmin();
    const { variantId } = await createVariantFixture(token);

    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 5 })
      .expect(400);
    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 5, reason: '' })
      .expect(400);

    const adjusted = await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 10, reason: 'Réception fournisseur' })
      .expect(201);
    expect(adjusted.body.quantityOnHand).toBe(10);

    const history = await ctx
      .http()
      .get(`/v1/admin/inventory/${variantId}/movements`)
      .set('Authorization', bearer(token))
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({
      type: 'RECEIPT',
      quantity: 10,
      reason: 'Réception fournisseur',
      createdByEmail: admin.email,
    });

    // Un ajustement qui rendrait le stock négatif est refusé.
    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'ADJUSTMENT', quantity: -50, reason: 'Correction excessive' })
      .expect(400);
  });

  /* ------------------------- Critère 3 : alerte de seuil --------------------- */

  it('CRITÈRE 3 : franchissement du seuil à la baisse → alerte courriel reçue', async () => {
    const { token } = await catalogueAdmin();
    const { variantId, sku } = await createVariantFixture(token);

    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 20, reason: 'Réception' })
      .expect(201);
    await ctx
      .http()
      .patch(`/v1/admin/inventory/${variantId}/threshold`)
      .set('Authorization', bearer(token))
      .send({ lowStockThreshold: 5 })
      .expect(200);

    const before = ctx.mail.outbox.length;

    // Ajustement qui fait passer la quantité en main sous le seuil (20 → 3).
    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'ADJUSTMENT', quantity: -17, reason: 'Correction inventaire' })
      .expect(201);

    expect(ctx.mail.outbox.length).toBe(before + 1);
    const mail = lastMail(ctx, 'inventaire@filtrationmontreal.com', 'inventory_low_stock');
    expect(mail).toBeDefined();
    expect(mail!.variables.sku).toBe(sku);
    expect(mail!.variables.quantityOnHand).toBe('3');

    // Un second ajustement qui reste sous le seuil ne redéclenche pas d'alerte.
    const afterFirstAlert = ctx.mail.outbox.length;
    await ctx
      .http()
      .post(`/v1/admin/inventory/${variantId}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'ADJUSTMENT', quantity: -1, reason: 'Bris' })
      .expect(201);
    expect(ctx.mail.outbox.length).toBe(afterFirstAlert);
  });

  /* ------------------------ Critère 4 : lecture_seule ------------------------ */

  it('CRITÈRE 4 : un compte lecture_seule voit tout mais ne peut rien modifier', async () => {
    const reader = await makeAdminWithMfa(ctx, ['lecture_seule']);
    const token = await adminLogin(ctx, reader.email, reader.password, reader.recoveryCodes[0]!);

    await ctx.http().get('/v1/admin/products').set('Authorization', bearer(token)).expect(200);
    await ctx.http().get('/v1/admin/brands').set('Authorization', bearer(token)).expect(200);
    await ctx.http().get('/v1/admin/categories').set('Authorization', bearer(token)).expect(200);
    await ctx.http().get('/v1/admin/inventory').set('Authorization', bearer(token)).expect(200);

    await ctx
      .http()
      .post('/v1/admin/products')
      .set('Authorization', bearer(token))
      .send({ brandId })
      .expect(403);
    await ctx
      .http()
      .post('/v1/admin/brands')
      .set('Authorization', bearer(token))
      .send({ slug: `refuse-${randomUUID().slice(0, 6)}`, name: 'Refusé' })
      .expect(403);
    await ctx
      .http()
      .post(`/v1/admin/inventory/${randomUUID()}/adjustments`)
      .set('Authorization', bearer(token))
      .send({ type: 'RECEIPT', quantity: 1, reason: 'x' })
      .expect(403);
  });

  /* ------------------------------- Catégories -------------------------------- */

  it('déplacer une catégorie sous son propre descendant est refusé (anti-cycle)', async () => {
    const { token } = await catalogueAdmin();
    const suffix = randomUUID().slice(0, 6);
    const parent = await ctx
      .http()
      .post('/v1/admin/categories')
      .set('Authorization', bearer(token))
      .send({ translations: { fr: { name: 'Parent', slug: `parent-${suffix}` } } })
      .expect(201);
    const child = await ctx
      .http()
      .post('/v1/admin/categories')
      .set('Authorization', bearer(token))
      .send({
        parentId: parent.body.id,
        translations: { fr: { name: 'Enfant', slug: `enfant-${suffix}` } },
      })
      .expect(201);

    await ctx
      .http()
      .patch(`/v1/admin/categories/${parent.body.id}/move`)
      .set('Authorization', bearer(token))
      .send({ parentId: child.body.id })
      .expect(400);
  });
});
