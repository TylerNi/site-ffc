/**
 * Import idempotent du plan transformé vers la base Prisma (tâche 08 §5).
 *
 * Idempotence : upsert par `bigcommerceBrandId`/`bigcommerceCategoryId`/
 * `bigcommerceProductId` (produits) et par `sku` (variantes, déjà unique en
 * base). Deux exécutions consécutives du même plan → mêmes comptes, aucun
 * doublon (critère d'acceptation de la tâche 08).
 *
 * `--dry-run` : exécute exactement le même chemin de code à l'intérieur
 * d'une transaction, puis la fait échouer volontairement (rollback) — les
 * comptes retournés reflètent donc fidèlement ce qu'un run réel ferait, sans
 * écrire ni appeler le stockage d'images.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ImageStore } from './images';
import type { ImportPlan, PlannedCategory } from './transform';

export interface ImportCounts {
  brandsCreated: number;
  brandsUpdated: number;
  categoriesCreated: number;
  categoriesUpdated: number;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  imagesUpserted: number;
}

export interface ImportOptions {
  dryRun?: boolean;
  imageStore: ImageStore;
  actorType?: string;
  actorId?: string | null;
}

export interface ImportResult {
  dryRun: boolean;
  counts: ImportCounts;
}

class DryRunRollback extends Error {}

function emptyCounts(): ImportCounts {
  return {
    brandsCreated: 0,
    brandsUpdated: 0,
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    imagesUpserted: 0,
  };
}

/** Ordonne les catégories parent-avant-enfant (les BigCommerce IDs bruts
 *  n'ont pas d'ordre topologique garanti). */
function topologicalCategories(categories: PlannedCategory[]): PlannedCategory[] {
  const remaining = [...categories];
  const resolved = new Set<string>();
  const ordered: PlannedCategory[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (category) =>
        category.parentBigcommerceCategoryId === null ||
        resolved.has(category.parentBigcommerceCategoryId),
    );
    if (index === -1) {
      throw new Error(
        `Cycle ou parent introuvable parmi les catégories BigCommerce : ${remaining
          .map((c) => c.bigcommerceCategoryId)
          .join(', ')}`,
      );
    }
    const [category] = remaining.splice(index, 1);
    ordered.push(category!);
    resolved.add(category!.bigcommerceCategoryId);
  }

  return ordered;
}

export async function importCatalog(
  prisma: PrismaClient,
  plan: ImportPlan,
  options: ImportOptions,
): Promise<ImportResult> {
  const dryRun = options.dryRun ?? false;
  const counts = emptyCounts();

  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    // --- Marques
    const brandIdByKey = new Map<string, string>();
    for (const brand of plan.brands) {
      const existing = await tx.brand.findUnique({
        where: { bigcommerceBrandId: brand.bigcommerceBrandId },
      });
      const row = await tx.brand.upsert({
        where: { bigcommerceBrandId: brand.bigcommerceBrandId },
        create: {
          bigcommerceBrandId: brand.bigcommerceBrandId,
          slug: brand.slug,
          name: brand.name,
          logoUrl: brand.logoUrl,
        },
        update: { slug: brand.slug, name: brand.name, logoUrl: brand.logoUrl },
      });
      brandIdByKey.set(brand.key, row.id);
      if (existing) counts.brandsUpdated += 1;
      else counts.brandsCreated += 1;
    }

    // --- Catégories (parent avant enfant)
    const categoryIdByBcId = new Map<string, string>();
    for (const category of topologicalCategories(plan.categories)) {
      const parentId = category.parentBigcommerceCategoryId
        ? (categoryIdByBcId.get(category.parentBigcommerceCategoryId) ?? null)
        : null;

      const existing = await tx.category.findUnique({
        where: { bigcommerceCategoryId: category.bigcommerceCategoryId },
      });
      const row = await tx.category.upsert({
        where: { bigcommerceCategoryId: category.bigcommerceCategoryId },
        create: {
          bigcommerceCategoryId: category.bigcommerceCategoryId,
          parentId,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
        },
        update: { parentId, sortOrder: category.sortOrder, isActive: category.isActive },
      });
      categoryIdByBcId.set(category.bigcommerceCategoryId, row.id);
      if (existing) counts.categoriesUpdated += 1;
      else counts.categoriesCreated += 1;

      for (const translation of category.translations) {
        await tx.categoryTranslation.upsert({
          where: { categoryId_locale: { categoryId: row.id, locale: translation.locale } },
          create: {
            categoryId: row.id,
            locale: translation.locale,
            name: translation.name,
            slug: translation.slug,
            description: translation.description,
          },
          update: {
            name: translation.name,
            slug: translation.slug,
            description: translation.description,
          },
        });
      }
    }

    // --- Produits, traductions, variantes, images
    for (const product of plan.products) {
      const brandId = brandIdByKey.get(product.brandKey) ?? brandIdByKey.get('')!;
      const categoryId = product.categoryBigcommerceId
        ? (categoryIdByBcId.get(product.categoryBigcommerceId) ?? null)
        : null;

      const existingProduct = await tx.product.findUnique({
        where: { bigcommerceProductId: product.bigcommerceProductId },
      });
      const row = await tx.product.upsert({
        where: { bigcommerceProductId: product.bigcommerceProductId },
        create: {
          bigcommerceProductId: product.bigcommerceProductId,
          brandId,
          categoryId,
          status: product.status,
          isFeatured: product.isFeatured,
        },
        update: { brandId, categoryId, status: product.status, isFeatured: product.isFeatured },
      });
      if (existingProduct) counts.productsUpdated += 1;
      else counts.productsCreated += 1;

      for (const translation of product.translations) {
        await tx.productTranslation.upsert({
          where: { productId_locale: { productId: row.id, locale: translation.locale } },
          create: {
            productId: row.id,
            locale: translation.locale,
            name: translation.name,
            slug: translation.slug,
            description: translation.description,
            shortDescription: translation.shortDescription,
            metaTitle: translation.metaTitle,
            metaDescription: translation.metaDescription,
          },
          update: {
            name: translation.name,
            slug: translation.slug,
            description: translation.description,
            shortDescription: translation.shortDescription,
            metaTitle: translation.metaTitle,
            metaDescription: translation.metaDescription,
          },
        });
      }

      for (const variant of product.variants) {
        const existingVariant = await tx.productVariant.findUnique({ where: { sku: variant.sku } });
        await tx.productVariant.upsert({
          where: { sku: variant.sku },
          create: {
            productId: row.id,
            sku: variant.sku,
            bigcommerceVariantId: variant.bigcommerceVariantId,
            barcode: variant.barcode,
            nominalLabel: variant.nominalLabel,
            nominalWidthIn: variant.nominalDimensions.width,
            nominalHeightIn: variant.nominalDimensions.height,
            nominalDepthIn: variant.nominalDimensions.depth,
            actualWidthIn: variant.actualDimensions.width,
            actualHeightIn: variant.actualDimensions.height,
            actualDepthIn: variant.actualDimensions.depth,
            merv: variant.merv,
            packSize: variant.packSize,
            priceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            costCents: variant.costCents,
            weightGrams: variant.weightGrams,
            isActive: variant.isActive,
            position: variant.position,
          },
          update: {
            productId: row.id,
            bigcommerceVariantId: variant.bigcommerceVariantId,
            barcode: variant.barcode,
            nominalLabel: variant.nominalLabel,
            nominalWidthIn: variant.nominalDimensions.width,
            nominalHeightIn: variant.nominalDimensions.height,
            nominalDepthIn: variant.nominalDimensions.depth,
            actualWidthIn: variant.actualDimensions.width,
            actualHeightIn: variant.actualDimensions.height,
            actualDepthIn: variant.actualDimensions.depth,
            merv: variant.merv,
            packSize: variant.packSize,
            priceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            costCents: variant.costCents,
            weightGrams: variant.weightGrams,
            isActive: variant.isActive,
            position: variant.position,
          },
        });
        if (existingVariant) counts.variantsUpdated += 1;
        else counts.variantsCreated += 1;
      }

      // Remplacement complet des images : simple, idempotent, jamais de doublon.
      await tx.productImage.deleteMany({ where: { productId: row.id } });
      if (product.images.length > 0) {
        const uploaded = dryRun
          ? product.images.map(() => ({ key: '', width: 0, height: 0 }))
          : await Promise.all(
              product.images.map((image, index) =>
                options.imageStore.store(image.sourceUrl, `${row.id}/${index}`),
              ),
            );
        if (!dryRun) {
          await tx.productImage.createMany({
            data: product.images.map((image, index) => ({
              productId: row.id,
              url: uploaded[index]!.key,
              altFr: image.altFr,
              altEn: image.altEn,
              width: uploaded[index]!.width || null,
              height: uploaded[index]!.height || null,
              position: image.position,
            })),
          });
        }
        counts.imagesUpserted += product.images.length;
      }
    }

    await tx.auditLog.create({
      data: {
        actorType: options.actorType ?? 'system',
        actorId: options.actorId ?? null,
        action: 'catalog.import',
        entityType: 'catalog',
        metadata: { dryRun, counts: { ...counts } },
      },
    });

    if (dryRun) throw new DryRunRollback();
  };

  try {
    await prisma.$transaction(run, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  return { dryRun, counts };
}
