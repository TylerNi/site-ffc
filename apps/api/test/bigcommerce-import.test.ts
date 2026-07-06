import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog } from '../src/bigcommerce/import';
import { InMemoryImageStore } from '../src/bigcommerce/images';
import { buildImportPlan } from '../src/bigcommerce/transform';
import { buildFixtureCatalogExport } from './fixtures/bigcommerce';
import { createTestClient } from './helpers';

/**
 * Import idempotent (tâche 08 §5) : deux exécutions consécutives du même
 * plan → mêmes comptes, aucun doublon en base (critère d'acceptation).
 */
describe('bigcommerce/import — importCatalog', () => {
  let prisma: PrismaClient;
  const { plan } = buildImportPlan(buildFixtureCatalogExport());

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    // La base ffc_test est partagée entre fichiers de test (fileParallelism
    // désactivé) : on efface ce que CE fichier a créé pour ne pas fausser les
    // comptes d'autres suites (ex. trigram-search.test.ts, seedé à 40 produits).
    await prisma.product.deleteMany({ where: { bigcommerceProductId: { not: null } } });
    await prisma.category.deleteMany({ where: { bigcommerceCategoryId: { not: null } } });
    await prisma.brand.deleteMany({ where: { bigcommerceBrandId: { not: null } } });
    await prisma.$disconnect();
  });

  it("dry-run : calcule les comptes sans écrire ni appeler le stockage d'images", async () => {
    const imageStore = new InMemoryImageStore();
    const before = await prisma.product.count({ where: { bigcommerceProductId: { not: null } } });

    const result = await importCatalog(prisma, plan, { dryRun: true, imageStore });

    expect(result.dryRun).toBe(true);
    expect(result.counts.productsCreated).toBe(plan.products.length);
    expect(imageStore.stored).toHaveLength(0); // aucun appel réseau en dry-run
    const after = await prisma.product.count({ where: { bigcommerceProductId: { not: null } } });
    expect(after).toBe(before); // rollback : rien n'a été écrit
  });

  it('premier import réel : crée marques/catégories/produits/variantes/images', async () => {
    const imageStore = new InMemoryImageStore();
    const result = await importCatalog(prisma, plan, { dryRun: false, imageStore });

    expect(result.dryRun).toBe(false);
    expect(result.counts.productsCreated).toBe(plan.products.length);
    expect(result.counts.productsUpdated).toBe(0);
    expect(result.counts.brandsCreated).toBe(plan.brands.length);
    expect(result.counts.categoriesCreated).toBe(plan.categories.length);

    const productA = await prisma.product.findUniqueOrThrow({
      where: { bigcommerceProductId: 'en:301' },
      include: { translations: true, variants: true, images: true, brand: true, category: true },
    });
    expect(productA.translations).toHaveLength(2);
    expect(productA.variants).toHaveLength(1);
    expect(productA.variants[0]!.sku).toBe('FF-16x25x1-M11-6');
    expect(Number(productA.variants[0]!.actualWidthIn)).toBeCloseTo(15.75);
    expect(productA.images).toHaveLength(2);
    expect(productA.brand.slug).toBeTruthy();

    const auditLog = await prisma.auditLog.findFirst({
      where: { action: 'catalog.import' },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditLog).not.toBeNull();
  });

  it('deuxième import du même plan : zéro création, mêmes comptes, aucun doublon', async () => {
    const countsBefore = {
      products: await prisma.product.count(),
      variants: await prisma.productVariant.count(),
      brands: await prisma.brand.count(),
      categories: await prisma.category.count(),
      images: await prisma.productImage.count(),
    };

    const imageStore = new InMemoryImageStore();
    const result = await importCatalog(prisma, plan, { dryRun: false, imageStore });

    expect(result.counts.productsCreated).toBe(0);
    expect(result.counts.productsUpdated).toBe(plan.products.length);
    expect(result.counts.brandsCreated).toBe(0);
    expect(result.counts.categoriesCreated).toBe(0);

    const countsAfter = {
      products: await prisma.product.count(),
      variants: await prisma.productVariant.count(),
      brands: await prisma.brand.count(),
      categories: await prisma.category.count(),
      images: await prisma.productImage.count(),
    };
    expect(countsAfter).toEqual(countsBefore); // rejouable sans doublon
  });

  it("un SKU réel ne peut appartenir qu'à une seule variante en base", async () => {
    const variant = await prisma.productVariant.findUnique({ where: { sku: 'FF-DUPLICATE-1' } });
    expect(variant).not.toBeNull();
    // Le produit H a perdu sa variante (SKU déjà pris par G) — aucune violation
    // de contrainte unique ne s'est produite pendant l'import.
    const h = await prisma.product.findUniqueOrThrow({
      where: { bigcommerceProductId: 'en:307' },
      include: { variants: true },
    });
    expect(h.variants).toHaveLength(0);
  });
});
