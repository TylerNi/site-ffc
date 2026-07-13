/**
 * Seed de développement — catalogue réaliste + données de démonstration.
 *
 * Exécution : `pnpm db:seed` (ou automatiquement par `prisma migrate reset`).
 * Prérequis : @ffc/core doit être construit (`pnpm build --filter @ffc/core`),
 * le seed réutilise ses tailles nominales et cotes MERV.
 *
 * IDEMPOTENT : identifiants déterministes + upserts/gardes — ré-exécutable
 * sans reset et sans doublon. Les tests d'intégration l'importent comme
 * fonction (`seed(prisma)`).
 *
 * Contenu :
 *   - 3 marques, 4 catégories (1 parent + 3 profondeurs), 40 produits
 *     (tailles courantes × MERV 8/11/13) avec traductions fr/en et variantes
 *     multi-formats de boîte (110 variantes), images, inventaire.
 *   - 6 modèles d'équipement avec alias et compatibilités.
 *   - 2 fournisseurs avec prix d'achat.
 *   - RBAC de base (rôles + permissions), un admin, un client de test avec
 *     commande payée, facture (numérotée par allocate_invoice_number),
 *     expédition en transit, avis approuvé, plan de rappel, identification IA.
 */
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  MERV_RATINGS,
  NOMINAL_FILTER_SIZES,
  type NominalFilterSize,
  PERMISSION_WILDCARD,
  PROVINCES,
} from '@ffc/core';
import { type Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { allocateInvoiceNumber, invoiceSeries } from '../src/database/invoice-number';
import { allocateOrderNumber } from '../src/database/order-number';

/* ------------------------------------------------------------------ */
/* Identifiants déterministes (idempotence)                            */
/* ------------------------------------------------------------------ */

/** UUID stable et lisible : seedId(2, 13) → 00000000-0000-4000-8002-000000000013. */
function seedId(block: number, n: number): string {
  return `00000000-0000-4000-8${String(block).padStart(3, '0')}-${String(n).padStart(12, '0')}`;
}

const ID = {
  brand: (n: number) => seedId(1, n),
  category: (n: number) => seedId(2, n),
  product: (n: number) => seedId(3, n),
  variant: (n: number) => seedId(4, n),
  image: (n: number) => seedId(5, n),
  equipment: (n: number) => seedId(6, n),
  supplier: (n: number) => seedId(7, n),
  user: (n: number) => seedId(8, n),
  role: (n: number) => seedId(9, n),
  permission: (n: number) => seedId(10, n),
  order: (n: number) => seedId(11, n),
  coupon: (n: number) => seedId(12, n),
};

/* ------------------------------------------------------------------ */
/* Définition du catalogue                                             */
/* ------------------------------------------------------------------ */

interface BrandSeed {
  id: string;
  slug: string;
  name: string;
  code: string;
}

/** Marques fictives — les vraies arrivent avec l'import BigCommerce (tâche 08). */
const BRANDS = [
  { id: ID.brand(1), slug: 'pureflow', name: 'PureFlow', code: 'PF' },
  { id: ID.brand(2), slug: 'boreal-filtration', name: 'Boréal Filtration', code: 'BF' },
  { id: ID.brand(3), slug: 'nordicair', name: 'NordicAir', code: 'NA' },
] as const satisfies readonly BrandSeed[];

/** Marque par cote MERV : entrée de gamme, milieu, haut de gamme. */
function brandForMerv(merv: number): BrandSeed {
  if (merv <= 8) return BRANDS[0];
  if (merv <= 11) return BRANDS[1];
  return BRANDS[2];
}

interface ProductSeed {
  index: number;
  size: NominalFilterSize;
  merv: number;
  brand: BrandSeed;
  categoryIndex: number;
  packSizes: number[];
  unitPriceCents: number;
}

/** Prix unitaire (cents) par profondeur puis par MERV. */
const UNIT_PRICE_CENTS: Record<number, Record<number, number>> = {
  1: { 8: 999, 11: 1399, 13: 1899 },
  4: { 8: 2999, 11: 3999, 13: 4999 },
  5: { 8: 3999, 11: 4499, 13: 5499 },
};

function unitPriceFor(depth: number, merv: number): number {
  const price = UNIT_PRICE_CENTS[depth]?.[merv];
  if (price === undefined) throw new Error(`Prix seed manquant pour ${depth} po / MERV ${merv}`);
  return price;
}

/** Rabais de volume par format de boîte. */
const PACK_MULTIPLIER: Record<number, number> = { 1: 1, 4: 0.95, 6: 0.95, 12: 0.9 };

/** Poids unitaire (grammes) par profondeur. */
const UNIT_WEIGHT_GRAMS: Record<number, number> = { 1: 350, 4: 1200, 5: 1500 };

function unitWeightFor(depth: number): number {
  return UNIT_WEIGHT_GRAMS[depth] ?? 500;
}

function buildProductSeeds(): ProductSeed[] {
  const oneInch = NOMINAL_FILTER_SIZES.filter((size) => size.nominalDimensions.depth === 1);
  const fourInch = NOMINAL_FILTER_SIZES.filter((size) => size.nominalDimensions.depth === 4);
  const fiveInch = NOMINAL_FILTER_SIZES.filter((size) => size.nominalDimensions.depth === 5);

  const seeds: ProductSeed[] = [];
  let index = 1;
  // 10 tailles 1 po × MERV 8/11/13 = 30 produits, boîtes de 1/6/12.
  for (const merv of [8, 11, 13]) {
    for (const size of oneInch) {
      seeds.push({
        index: index++,
        size,
        merv,
        brand: brandForMerv(merv),
        categoryIndex: 2,
        packSizes: [1, 6, 12],
        unitPriceCents: unitPriceFor(1, merv),
      });
    }
  }
  // 2 tailles 4 po × MERV 8/11/13 = 6 produits, boîtes de 1/4.
  for (const merv of [8, 11, 13]) {
    for (const size of fourInch) {
      seeds.push({
        index: index++,
        size,
        merv,
        brand: brandForMerv(merv),
        categoryIndex: 3,
        packSizes: [1, 4],
        unitPriceCents: unitPriceFor(4, merv),
      });
    }
  }
  // 2 tailles 5 po × MERV 11/13 = 4 produits, boîtes de 1/4.
  for (const merv of [11, 13]) {
    for (const size of fiveInch) {
      seeds.push({
        index: index++,
        size,
        merv,
        brand: brandForMerv(merv),
        categoryIndex: 4,
        packSizes: [1, 4],
        unitPriceCents: unitPriceFor(5, merv),
      });
    }
  }
  return seeds;
}

function mervDescription(merv: number): { fr: string; en: string } {
  const rating = MERV_RATINGS.find((r) => r.value === merv);
  return rating
    ? rating.description
    : { fr: `Filtration MERV ${merv}`, en: `MERV ${merv} filtration` };
}

/** « 16x25x1 » → « 16-25-1 » (fragment de slug/SKU). */
function sizeSlug(size: NominalFilterSize): string {
  return size.nominal.replaceAll('x', '-');
}

function packPriceCents(unitCents: number, pack: number): number {
  return Math.round(unitCents * pack * (PACK_MULTIPLIER[pack] ?? 1));
}

/* ------------------------------------------------------------------ */
/* Aides monétaires (montants en cents)                                */
/* ------------------------------------------------------------------ */

function roundCents(value: number): number {
  return Math.round(value);
}

/** Taxes du Québec sur un montant en cents. */
function quebecTaxes(taxableCents: number): { gst: number; qst: number } {
  const rates = PROVINCES.QC.taxes;
  const gstRate = rates.find((t) => t.kind === 'GST')?.rate ?? 0.05;
  const qstRate = rates.find((t) => t.kind === 'QST')?.rate ?? 0.09975;
  return {
    gst: roundCents(taxableCents * gstRate),
    qst: roundCents(taxableCents * qstRate),
  };
}

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

export async function seed(prisma: PrismaClient): Promise<void> {
  await seedBrandsAndCategories(prisma);
  await seedProducts(prisma, buildProductSeeds());
  await seedEquipment(prisma);
  await seedSuppliers(prisma);
  await seedRbac(prisma);
  await seedUsers(prisma);
  await seedCouponAndSettings(prisma);
  await seedDemoOrder(prisma);
  await seedDemoExtras(prisma);
}

async function seedBrandsAndCategories(prisma: PrismaClient): Promise<void> {
  for (const brand of BRANDS) {
    await prisma.brand.upsert({
      where: { id: brand.id },
      update: { slug: brand.slug, name: brand.name },
      create: { id: brand.id, slug: brand.slug, name: brand.name },
    });
  }

  const categories = [
    {
      id: ID.category(1),
      parentId: null as string | null,
      sortOrder: 0,
      fr: { name: 'Filtres de fournaise', slug: 'filtres-de-fournaise' },
      en: { name: 'Furnace Filters', slug: 'furnace-filters' },
    },
    {
      id: ID.category(2),
      parentId: ID.category(1),
      sortOrder: 1,
      fr: { name: 'Filtres 1 pouce', slug: 'filtres-1-pouce' },
      en: { name: '1-Inch Filters', slug: '1-inch-filters' },
    },
    {
      id: ID.category(3),
      parentId: ID.category(1),
      sortOrder: 2,
      fr: { name: 'Filtres 4 pouces', slug: 'filtres-4-pouces' },
      en: { name: '4-Inch Filters', slug: '4-inch-filters' },
    },
    {
      id: ID.category(4),
      parentId: ID.category(1),
      sortOrder: 3,
      fr: { name: 'Filtres 5 pouces', slug: 'filtres-5-pouces' },
      en: { name: '5-Inch Filters', slug: '5-inch-filters' },
    },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: { parentId: category.parentId, sortOrder: category.sortOrder },
      create: { id: category.id, parentId: category.parentId, sortOrder: category.sortOrder },
    });
    for (const locale of ['fr', 'en'] as const) {
      const translation = category[locale];
      await prisma.categoryTranslation.upsert({
        where: { categoryId_locale: { categoryId: category.id, locale } },
        update: { name: translation.name, slug: translation.slug },
        create: {
          categoryId: category.id,
          locale,
          name: translation.name,
          slug: translation.slug,
        },
      });
    }
  }
}

async function seedProducts(prisma: PrismaClient, products: ProductSeed[]): Promise<void> {
  let variantCounter = 0;
  let imageCounter = 0;

  for (const item of products) {
    const { size, merv, brand } = item;
    const description = mervDescription(merv);
    const nameFr = `Filtre à fournaise ${brand.name} MERV ${merv} — ${size.nominal}`;
    const nameEn = `${brand.name} MERV ${merv} Furnace Filter — ${size.nominal}`;
    const slugFr = `filtre-fournaise-${brand.slug}-merv-${merv}-${sizeSlug(size)}`;
    const slugEn = `${brand.slug}-merv-${merv}-furnace-filter-${sizeSlug(size)}`;

    await prisma.product.upsert({
      where: { id: ID.product(item.index) },
      update: { brandId: brand.id, categoryId: ID.category(item.categoryIndex), status: 'ACTIVE' },
      create: {
        id: ID.product(item.index),
        brandId: brand.id,
        categoryId: ID.category(item.categoryIndex),
        status: 'ACTIVE',
        isFeatured: merv === 11 && size.nominal === '16x25x1',
      },
    });

    const translations = [
      {
        locale: 'fr' as const,
        name: nameFr,
        slug: slugFr,
        shortDescription: description.fr,
        description:
          `Filtre plissé ${size.nominal} (dimensions réelles ${size.actualDimensions.width} × ` +
          `${size.actualDimensions.height} × ${size.actualDimensions.depth} po), cote MERV ${merv}. ` +
          `${description.fr}. Remplacement recommandé aux 90 jours (1 po) ou aux 6–12 mois (4–5 po).`,
        metaTitle: `${nameFr} | Filtration Montréal`,
        metaDescription: `Achetez le ${nameFr} en ligne — livraison rapide partout au Québec et au Canada.`,
      },
      {
        locale: 'en' as const,
        name: nameEn,
        slug: slugEn,
        shortDescription: description.en,
        description:
          `Pleated ${size.nominal} filter (actual size ${size.actualDimensions.width} × ` +
          `${size.actualDimensions.height} × ${size.actualDimensions.depth} in), MERV ${merv} rating. ` +
          `${description.en}. Replace every 90 days (1") or every 6–12 months (4–5").`,
        metaTitle: `${nameEn} | Furnace Filters Canada`,
        metaDescription: `Buy the ${nameEn} online — fast shipping across Canada.`,
      },
    ];
    for (const translation of translations) {
      await prisma.productTranslation.upsert({
        where: {
          productId_locale: { productId: ID.product(item.index), locale: translation.locale },
        },
        update: translation,
        create: { productId: ID.product(item.index), ...translation },
      });
    }

    for (const pack of item.packSizes) {
      variantCounter += 1;
      const variantId = ID.variant(variantCounter);
      const sku = `${brand.code}-${sizeSlug(size)}-M${merv}-P${pack}`;
      const priceCents = packPriceCents(item.unitPriceCents, pack);
      const quantityOnHand = 10 + ((item.index * 7 + pack * 13) % 60);

      await prisma.productVariant.upsert({
        where: { id: variantId },
        update: { priceCents, isActive: true },
        create: {
          id: variantId,
          productId: ID.product(item.index),
          sku,
          nominalLabel: size.nominal,
          nominalWidthIn: size.nominalDimensions.width.toFixed(2),
          nominalHeightIn: size.nominalDimensions.height.toFixed(2),
          nominalDepthIn: size.nominalDimensions.depth.toFixed(2),
          actualWidthIn: size.actualDimensions.width.toFixed(2),
          actualHeightIn: size.actualDimensions.height.toFixed(2),
          actualDepthIn: size.actualDimensions.depth.toFixed(2),
          merv,
          packSize: pack,
          priceCents,
          compareAtPriceCents: merv === 13 && pack === 1 ? roundCents(priceCents * 1.2) : null,
          costCents: roundCents(priceCents * 0.45),
          currency: 'CAD',
          weightGrams: unitWeightFor(size.nominalDimensions.depth) * pack + 120,
          position: pack,
        },
      });

      await prisma.inventoryLevel.upsert({
        where: { variantId },
        update: {},
        create: {
          variantId,
          quantityOnHand,
          quantityReserved: 0,
          lowStockThreshold: pack === 1 ? 5 : 2,
        },
      });

      // Réception initiale : le grand livre d'inventaire part d'un mouvement réel.
      const existingReceipt = await prisma.inventoryMovement.findFirst({
        where: { variantId, type: 'RECEIPT' },
        select: { id: true },
      });
      if (!existingReceipt) {
        await prisma.inventoryMovement.create({
          data: {
            variantId,
            type: 'RECEIPT',
            quantity: quantityOnHand,
            reason: 'Inventaire initial (seed)',
          },
        });
      }
    }

    imageCounter += 1;
    await prisma.productImage.upsert({
      where: { id: ID.image(imageCounter) },
      update: {},
      create: {
        id: ID.image(imageCounter),
        productId: ID.product(item.index),
        url: `products/${slugEn}/principale.jpg`,
        altFr: nameFr,
        altEn: nameEn,
        width: 1200,
        height: 1200,
        position: 0,
      },
    });
  }
}

async function seedEquipment(prisma: PrismaClient): Promise<void> {
  const equipmentModels = [
    {
      id: ID.equipment(1),
      manufacturer: 'Lennox',
      modelNumber: 'G61MPV',
      kind: 'FURNACE' as const,
      aliases: ['G61MPV-36B-070', 'G61MPV-48C-090', 'G61'],
      notes: 'Fournaise à condensation à vitesse variable — cabinet média 16x25x5.',
      sizes: ['16x25x5'],
    },
    {
      id: ID.equipment(2),
      manufacturer: 'Carrier',
      modelNumber: '59SC5',
      kind: 'FURNACE' as const,
      aliases: ['59SC5A', '59SC5A060S17'],
      notes: 'Compatible cabinet média 16x25x4.',
      sizes: ['16x25x4'],
    },
    {
      id: ID.equipment(3),
      manufacturer: 'Goodman',
      modelNumber: 'GMVC96',
      kind: 'FURNACE' as const,
      aliases: ['GMVC960603BN', 'GMVC96 0803'],
      notes: 'Filtre 20x25x4 dans le retour d’air.',
      sizes: ['20x25x4'],
    },
    {
      id: ID.equipment(4),
      manufacturer: 'Trane',
      modelNumber: 'XR95',
      kind: 'FURNACE' as const,
      aliases: ['TUH1B080A9421A'],
      notes: 'Retour d’air standard 16x25x1.',
      sizes: ['16x25x1'],
    },
    {
      id: ID.equipment(5),
      manufacturer: 'Honeywell',
      modelNumber: 'F100F2002',
      kind: 'AIR_HANDLER' as const,
      aliases: ['F100', 'F100F'],
      notes: 'Cabinet de filtration média — accepte 16x25x4 et 16x25x5.',
      sizes: ['16x25x4', '16x25x5'],
    },
    {
      id: ID.equipment(6),
      manufacturer: 'Venmar',
      modelNumber: 'Constructo 1.5',
      kind: 'HRV_ERV' as const,
      aliases: ['CONSTRUCTO1.5', '41255'],
      notes: 'VRC — filtre d’appoint 14x20x1 au retour.',
      sizes: ['14x20x1'],
    },
  ];

  for (const model of equipmentModels) {
    await prisma.equipmentModel.upsert({
      where: { id: model.id },
      update: { aliases: model.aliases, notes: model.notes },
      create: {
        id: model.id,
        manufacturer: model.manufacturer,
        modelNumber: model.modelNumber,
        kind: model.kind,
        aliases: model.aliases,
        notes: model.notes,
      },
    });

    // Compatibilités : toutes les variantes à l'unité (pack 1) des tailles listées.
    const variants = await prisma.productVariant.findMany({
      where: { nominalLabel: { in: model.sizes }, packSize: 1 },
      select: { id: true },
    });
    for (const variant of variants) {
      await prisma.modelFilterCompatibility.upsert({
        where: {
          equipmentModelId_variantId: { equipmentModelId: model.id, variantId: variant.id },
        },
        update: {},
        create: {
          equipmentModelId: model.id,
          variantId: variant.id,
          source: 'MANUAL',
          isVerified: true,
        },
      });
    }
  }
}

async function seedSuppliers(prisma: PrismaClient): Promise<void> {
  const suppliers = [
    {
      id: ID.supplier(1),
      code: 'FILTREX',
      name: 'Distribution Filtrex',
      email: 'commandes@filtrex.example',
      leadTimeDays: 5,
      minOrderCents: 25_000,
    },
    {
      id: ID.supplier(2),
      code: 'AIRPUR',
      name: 'Grossiste AirPur',
      email: 'ventes@airpur.example',
      leadTimeDays: 10,
      minOrderCents: 50_000,
    },
  ] as const;
  for (const supplier of suppliers) {
    await prisma.supplier.upsert({
      where: { id: supplier.id },
      update: {},
      create: supplier,
    });
  }

  // Chaque fournisseur couvre une partie du catalogue (unités seulement).
  const variants = await prisma.productVariant.findMany({
    where: { packSize: 1 },
    select: { id: true, sku: true, costCents: true, merv: true },
    orderBy: { sku: 'asc' },
  });
  for (const [index, variant] of variants.entries()) {
    const supplier = index % 2 === 0 ? suppliers[0] : suppliers[1];
    await prisma.supplierProduct.upsert({
      where: { supplierId_variantId: { supplierId: supplier.id, variantId: variant.id } },
      update: {},
      create: {
        supplierId: supplier.id,
        variantId: variant.id,
        supplierSku: `${supplier.code}-${variant.sku}`,
        costCents: variant.costCents ?? 500,
        moq: 12,
        isPreferred: true,
      },
    });
  }
}

/**
 * RBAC fin (tâche 09) — permissions granulaires et rôles de départ, source
 * @ffc/core (ADMIN_PERMISSIONS / ADMIN_ROLES). Le rôle super_admin porte la
 * permission joker « * » (une seule ligne) : toute nouvelle permission lui est
 * accordée sans re-seed. Idempotent : upsert par clé stable.
 */
async function seedRbac(prisma: PrismaClient): Promise<void> {
  const permissions = [
    ...ADMIN_PERMISSIONS,
    { key: PERMISSION_WILDCARD, description: 'Toutes les permissions (réservé à super_admin)' },
  ];
  const permissionIdByKey = new Map<string, string>();
  for (const [index, permission] of permissions.entries()) {
    const row = await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description },
      create: {
        id: ID.permission(index + 1),
        key: permission.key,
        description: permission.description,
      },
    });
    permissionIdByKey.set(permission.key, row.id);
  }

  for (const [index, role] of ADMIN_ROLES.entries()) {
    const row = await prisma.role.upsert({
      where: { key: role.key },
      update: {
        nameFr: role.nameFr,
        nameEn: role.nameEn,
        description: role.description,
        isSystem: role.isSystem,
      },
      create: {
        id: ID.role(index + 1),
        key: role.key,
        nameFr: role.nameFr,
        nameEn: role.nameEn,
        description: role.description,
        isSystem: role.isSystem,
      },
    });
    for (const key of role.permissions) {
      const permissionId = permissionIdByKey.get(key);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: row.id, permissionId } },
        update: {},
        create: { roleId: row.id, permissionId },
      });
    }
  }
}

async function seedUsers(prisma: PrismaClient): Promise<void> {
  // Mots de passe DE DÉVELOPPEMENT seulement — jamais utilisés en production
  // (les comptes réels seront créés via les parcours d'auth de la tâche 05).
  const adminPassword = await argon2.hash('Admin123!ChangezMoi', { type: argon2.argon2id });
  const customerPassword = await argon2.hash('Client123!Test', { type: argon2.argon2id });

  await prisma.user.upsert({
    where: { id: ID.user(1) },
    update: { role: 'ADMIN' },
    create: {
      id: ID.user(1),
      email: 'admin@filtrationmontreal.com',
      emailVerifiedAt: new Date('2026-01-05T09:00:00Z'),
      passwordHash: adminPassword,
      firstName: 'Alexandre',
      lastName: 'Dupuis',
      role: 'ADMIN',
      status: 'ACTIVE',
      locale: 'fr',
    },
  });
  await prisma.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: ID.user(1), roleId: ID.role(1) } },
    update: {},
    create: { userId: ID.user(1), roleId: ID.role(1) },
  });

  await prisma.user.upsert({
    where: { id: ID.user(2) },
    update: {},
    create: {
      id: ID.user(2),
      email: 'client.test@example.com',
      emailVerifiedAt: new Date('2026-02-10T14:30:00Z'),
      passwordHash: customerPassword,
      firstName: 'Marie',
      lastName: 'Tremblay',
      phone: '+15145550142',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      locale: 'fr',
      addresses: {
        create: {
          label: 'Maison',
          firstName: 'Marie',
          lastName: 'Tremblay',
          line1: '1234, rue Sainte-Catherine Est',
          line2: 'App. 5',
          city: 'Montréal',
          province: 'QC',
          postalCode: 'H2L 2G8',
          country: 'CA',
          phone: '+15145550142',
          isDefaultShipping: true,
          isDefaultBilling: true,
        },
      },
    },
  });

  const preferences = [
    { category: 'TRANSACTIONAL', channel: 'EMAIL', enabled: true },
    { category: 'REPLENISHMENT_REMINDER', channel: 'EMAIL', enabled: true },
    { category: 'REVIEW_REQUEST', channel: 'EMAIL', enabled: true },
    { category: 'MARKETING', channel: 'EMAIL', enabled: false },
  ] as const;
  for (const preference of preferences) {
    await prisma.notificationPreference.upsert({
      where: {
        userId_category_channel: {
          userId: ID.user(2),
          category: preference.category,
          channel: preference.channel,
        },
      },
      update: {},
      create: {
        userId: ID.user(2),
        category: preference.category,
        channel: preference.channel,
        enabled: preference.enabled,
        consentAt: preference.enabled ? new Date('2026-02-10T14:31:00Z') : null,
        consentSource: preference.enabled ? 'creation-de-compte' : null,
      },
    });
  }
}

async function seedCouponAndSettings(prisma: PrismaClient): Promise<void> {
  await prisma.coupon.upsert({
    where: { id: ID.coupon(1) },
    update: {},
    create: {
      id: ID.coupon(1),
      code: 'BIENVENUE10',
      type: 'PERCENTAGE',
      valuePercent: 10,
      minSubtotalCents: 3000,
      maxRedemptionsPerUser: 1,
      isActive: true,
    },
  });

  const settings = [
    {
      key: 'boutique.courriels',
      value: {
        support: 'support@filtrationmontreal.com',
        ventes: 'info@furnacefilterscanada.com',
      },
      description: 'Adresses de contact affichées sur les vitrines.',
    },
    {
      key: 'expedition.seuil_livraison_gratuite_cents',
      value: 9900,
      description: 'Livraison gratuite à partir de ce sous-total (cents CAD).',
    },
    {
      key: 'expedition.frais_fixes_us_cents',
      value: 2500,
      description:
        'Frais de livraison fixes vers les États-Unis (cents CAD) — tâche 11. Le Canada est toujours gratuit.',
    },
    {
      key: 'inventaire.seuil_stock_bas_defaut',
      value: 5,
      description: 'Seuil d’alerte de stock bas par défaut (tâche 10).',
    },
    {
      key: 'ia.seuil_confiance',
      value: 0.85,
      description:
        'Seuil de confiance globale des identifications IA (tâche 17) : au-dessus → COMPLETED, en dessous ou sans correspondance → NEEDS_REVIEW.',
    },
    {
      key: 'ia.quota_quotidien',
      value: 10,
      description: 'Nombre maximal d’analyses IA par utilisateur et par jour (tâche 17).',
    },
    {
      // Coordonnées légales de l'entreprise — affichées sur les factures et
      // notes de crédit (tâche 12). Numéros d'inscription TPS/TVQ CONFIGURABLES
      // ici (le brief l'exige) ; valeurs de démonstration, à remplacer par les
      // vrais numéros avant la mise en production (accès tâche 01).
      key: 'entreprise.facturation',
      value: {
        raisonSociale: 'Filtration Montréal inc.',
        adresse: {
          line1: '1234, rue Sainte-Catherine Est',
          line2: 'Bureau 200',
          city: 'Montréal',
          province: 'QC',
          postalCode: 'H2L 2G8',
          country: 'CA',
        },
        courriel: 'facturation@filtrationmontreal.com',
        telephone: '+1 514-555-0142',
        // Numéros d'inscription aux taxes (démo — format réel : 9 chiffres RT/TQ).
        numeroTps: '000000000 RT0001',
        numeroTvq: '0000000000 TQ0001',
      },
      description:
        'Coordonnées légales et numéros d’inscription TPS/TVQ affichés sur les factures (tâche 12).',
    },
  ];
  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value as Prisma.InputJsonValue, description: setting.description },
      create: {
        key: setting.key,
        value: setting.value as Prisma.InputJsonValue,
        description: setting.description,
      },
    });
  }
}

/** Commande de démonstration complète : payée, facturée, expédiée, évaluée. */
async function seedDemoOrder(prisma: PrismaClient): Promise<void> {
  const orderId = ID.order(1);
  const existing = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (existing) return; // Idempotence : la commande de démo n'est créée qu'une fois.

  const customerId = ID.user(2);
  const line1Variant = await prisma.productVariant.findUniqueOrThrow({
    where: { sku: 'BF-16-25-1-M11-P6' },
    include: { product: { include: { translations: true } } },
  });
  const line2Variant = await prisma.productVariant.findUniqueOrThrow({
    where: { sku: 'NA-20-25-4-M13-P1' },
    include: { product: { include: { translations: true } } },
  });

  const nameOf = (variant: typeof line1Variant, locale: 'fr' | 'en'): string =>
    variant.product.translations.find((t) => t.locale === locale)?.name ?? variant.sku;

  const shippingAddress = {
    firstName: 'Marie',
    lastName: 'Tremblay',
    line1: '1234, rue Sainte-Catherine Est',
    line2: 'App. 5',
    city: 'Montréal',
    province: 'QC',
    postalCode: 'H2L 2G8',
    country: 'CA',
    phone: '+15145550142',
  };

  // Lignes de commande : remise BIENVENUE10 (10 %) et taxes calculées par
  // ligne ; les totaux de commande agrègent les lignes (cohérence au cent).
  const lines = [
    { variant: line1Variant, quantity: 1 },
    { variant: line2Variant, quantity: 2 },
  ].map(({ variant, quantity }) => {
    const subtotal = variant.priceCents * quantity;
    const discount = roundCents(subtotal * 0.1);
    const taxes = quebecTaxes(subtotal - discount);
    return { variant, quantity, subtotal, discount, taxCents: taxes.gst + taxes.qst };
  });

  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const discountCents = lines.reduce((sum, line) => sum + line.discount, 0);
  const shippingCents = 999;
  const taxableCents = subtotalCents - discountCents + shippingCents;
  const { gst, qst } = quebecTaxes(taxableCents);
  const totalCents = taxableCents + gst + qst;

  await prisma.$transaction(async (tx) => {
    const orderNumber = await allocateOrderNumber(tx);
    const placedAt = new Date('2026-06-15T15:12:00Z');

    const cart = await tx.cart.create({
      data: {
        userId: customerId,
        status: 'CONVERTED',
        currency: 'CAD',
        items: {
          create: lines.map((line) => ({
            variantId: line.variant.id,
            quantity: line.quantity,
            addedAtPriceCents: line.variant.priceCents,
          })),
        },
      },
    });

    const order = await tx.order.create({
      data: {
        id: orderId,
        number: orderNumber,
        userId: customerId,
        status: 'SHIPPED',
        channel: 'WEB',
        locale: 'fr',
        currency: 'CAD',
        subtotalCents,
        discountCents,
        shippingCents,
        taxGstCents: gst,
        taxQstCents: qst,
        totalCents,
        cartId: cart.id,
        couponId: ID.coupon(1),
        shippingAddress,
        billingAddress: shippingAddress,
        shippingProvince: 'QC',
        placedAt,
        paidAt: new Date('2026-06-15T15:13:05Z'),
        shippedAt: new Date('2026-06-16T18:40:00Z'),
        items: {
          create: lines.map((line) => ({
            variantId: line.variant.id,
            productId: line.variant.productId,
            sku: line.variant.sku,
            nameFr: nameOf(line.variant, 'fr'),
            nameEn: nameOf(line.variant, 'en'),
            nominalLabel: line.variant.nominalLabel,
            merv: line.variant.merv,
            packSize: line.variant.packSize,
            quantity: line.quantity,
            unitPriceCents: line.variant.priceCents,
            discountCents: line.discount,
            subtotalCents: line.subtotal - line.discount,
            taxCents: line.taxCents,
            totalCents: line.subtotal - line.discount + line.taxCents,
          })),
        },
        statusHistory: {
          create: [
            { toStatus: 'PENDING', createdAt: placedAt, note: 'Commande créée (seed)' },
            {
              fromStatus: 'PENDING',
              toStatus: 'PAID',
              createdAt: new Date('2026-06-15T15:13:05Z'),
              note: 'Paiement Stripe confirmé',
            },
            {
              fromStatus: 'PAID',
              toStatus: 'PROCESSING',
              createdAt: new Date('2026-06-16T13:00:00Z'),
            },
            {
              fromStatus: 'PROCESSING',
              toStatus: 'SHIPPED',
              createdAt: new Date('2026-06-16T18:40:00Z'),
              note: 'Remise au transporteur',
            },
          ],
        },
      },
    });

    await tx.couponRedemption.create({
      data: {
        couponId: ID.coupon(1),
        orderId: order.id,
        userId: customerId,
        amountDiscountedCents: discountCents,
      },
    });
    await tx.coupon.update({
      where: { id: ID.coupon(1) },
      data: { timesRedeemed: { increment: 1 } },
    });

    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: 'STRIPE',
        status: 'SUCCEEDED',
        amountCents: totalCents,
        currency: 'CAD',
        externalId: 'pi_seed_demo_0001',
        stripeChargeId: 'ch_seed_demo_0001',
        paymentMethodType: 'card',
        cardBrand: 'visa',
        cardLast4: '4242',
        capturedAt: new Date('2026-06-15T15:13:05Z'),
      },
    });

    // Facture officielle : numéro alloué par la fonction SQL (sans trou).
    const allocated = await allocateInvoiceNumber(tx, invoiceSeries('INVOICE', placedAt));
    await tx.invoice.create({
      data: {
        orderId: order.id,
        kind: 'INVOICE',
        status: 'ISSUED',
        series: allocated.series,
        sequence: allocated.sequence,
        number: allocated.number,
        currency: 'CAD',
        subtotalCents,
        discountCents,
        shippingCents,
        taxGstCents: gst,
        taxQstCents: qst,
        totalCents,
        issuedAt: new Date('2026-06-15T15:13:06Z'),
      },
    });

    // Sortie d'inventaire + décrément des niveaux.
    for (const line of lines) {
      await tx.inventoryMovement.create({
        data: {
          variantId: line.variant.id,
          type: 'SALE',
          quantity: -line.quantity,
          orderId: order.id,
          reason: `Commande ${orderNumber}`,
        },
      });
      await tx.inventoryLevel.update({
        where: { variantId: line.variant.id },
        data: { quantityOnHand: { decrement: line.quantity } },
      });
    }

    // Expédition Postes Canada en transit, avec événements de suivi dédupliqués.
    await tx.shipment.create({
      data: {
        orderId: order.id,
        shipstationOrderId: 'ss_order_seed_1',
        shipstationShipmentId: 'ss_ship_seed_1',
        carrier: 'CANADA_POST',
        carrierCode: 'canada_post',
        serviceCode: 'DOM.EP',
        trackingNumber: 'CP123456789CA',
        trackingUrl:
          'https://www.canadapost-postescanada.ca/track-reperage/fr#/details/CP123456789CA',
        status: 'IN_TRANSIT',
        costCents: 1245,
        currency: 'CAD',
        weightGrams: 4820,
        shippedAt: new Date('2026-06-16T18:40:00Z'),
        estimatedDeliveryAt: new Date('2026-06-19T21:00:00Z'),
        lastPolledAt: new Date('2026-06-17T12:00:00Z'),
        nextPollAt: new Date('2026-06-17T18:00:00Z'),
        events: {
          create: [
            {
              status: 'CREATED',
              code: 'INDUCTION',
              description: 'Étiquette créée',
              location: 'Montréal, QC',
              occurredAt: new Date('2026-06-16T18:40:00Z'),
              dedupKey: 'INDUCTION-2026-06-16T18:40',
            },
            {
              status: 'PICKED_UP',
              code: 'PICKUP',
              description: 'Colis pris en charge',
              location: 'Montréal, QC',
              occurredAt: new Date('2026-06-16T22:15:00Z'),
              dedupKey: 'PICKUP-2026-06-16T22:15',
            },
            {
              status: 'IN_TRANSIT',
              code: 'IN_TRANSIT',
              description: 'Colis en transit vers l’installation de tri',
              location: 'Laval, QC',
              occurredAt: new Date('2026-06-17T06:03:00Z'),
              dedupKey: 'IN_TRANSIT-2026-06-17T06:03',
            },
          ],
        },
      },
    });
  });
}

/** Après-vente : avis vérifié, équipement, plan de rappel, identification IA. */
async function seedDemoExtras(prisma: PrismaClient): Promise<void> {
  const customerId = ID.user(2);
  const order = await prisma.order.findUnique({
    where: { id: ID.order(1) },
    include: { items: true },
  });
  if (!order) return;

  const reviewedItem = order.items.find((item) => item.sku === 'BF-16-25-1-M11-P6');
  if (reviewedItem?.productId && reviewedItem.variantId) {
    await prisma.review.upsert({
      where: { orderItemId: reviewedItem.id },
      update: {},
      create: {
        productId: reviewedItem.productId,
        userId: customerId,
        orderItemId: reviewedItem.id,
        orderId: order.id,
        rating: 5,
        title: 'Excellent rapport qualité-prix',
        body: 'Installation facile, différence notable pour les allergies. La boîte de 6 est très pratique.',
        locale: 'fr',
        authorName: 'Marie T.',
        isVerifiedPurchase: true,
        status: 'APPROVED',
        moderatedByUserId: ID.user(1),
        moderatedAt: new Date('2026-06-22T10:00:00Z'),
      },
    });

    const equipment = await prisma.userEquipment.upsert({
      where: { id: seedId(13, 1) },
      update: {},
      create: {
        id: seedId(13, 1),
        userId: customerId,
        equipmentModelId: ID.equipment(1),
        nickname: 'Fournaise du sous-sol',
        installedFilterVariantId: reviewedItem.variantId,
        lastFilterChangeAt: new Date('2026-06-20T00:00:00Z'),
      },
    });

    await prisma.replenishmentPlan.upsert({
      where: { id: seedId(14, 1) },
      update: {},
      create: {
        id: seedId(14, 1),
        userId: customerId,
        variantId: reviewedItem.variantId,
        userEquipmentId: equipment.id,
        status: 'ACTIVE',
        intervalDays: 90,
        quantity: 1,
        nextReminderAt: new Date('2026-09-18T13:00:00Z'),
        lastOrderId: order.id,
      },
    });

    await prisma.notification.upsert({
      where: { id: seedId(15, 1) },
      update: {},
      create: {
        id: seedId(15, 1),
        userId: customerId,
        category: 'TRANSACTIONAL',
        channel: 'EMAIL',
        status: 'SENT',
        templateKey: 'order_confirmation',
        destination: 'client.test@example.com',
        subject: `Confirmation de votre commande ${order.number}`,
        payload: { orderNumber: order.number, totalCents: order.totalCents },
        orderId: order.id,
        externalId: 'ses-seed-0001',
        sentAt: new Date('2026-06-15T15:13:30Z'),
      },
    });
  }

  await prisma.aiIdentification.upsert({
    where: { id: seedId(16, 1) },
    update: {},
    create: {
      id: seedId(16, 1),
      userId: customerId,
      imageKey: 'ai-uploads/2026/06/seed-plaque-signaletique.jpg',
      status: 'NEEDS_REVIEW',
      provider: 'anthropic',
      model: 'claude-fable-5',
      extraction: {
        manufacturer: 'Lennox',
        modelNumber: 'G61MPV-36B-070',
        serialNumber: null,
        filterSizeHint: '16x25x5',
        rawText: 'LENNOX G61MPV-36B-070 · INPUT 66,000 BTU/H',
      },
      confidence: '0.620',
      purgeAt: new Date('2026-07-17T00:00:00Z'),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Point d'entrée CLI (prisma db seed)                                 */
/* ------------------------------------------------------------------ */

const isDirectRun = typeof require !== 'undefined' && require.main === module;

if (isDirectRun) {
  const prisma = new PrismaClient();
  seed(prisma)
    .then(async () => {
      await prisma.$disconnect();
      console.log('Seed terminé avec succès.');
    })
    .catch(async (error) => {
      console.error('Échec du seed :', error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
