/**
 * Transformation BigCommerce → schéma Prisma (tâche 08 §3). Fonction PURE
 * (aucun réseau, aucune base de données) : à partir d'un `CatalogExport`,
 * produit un `ImportPlan` prêt pour `import.ts` ainsi que les données du
 * rapport d'écarts (§6). Mapping champ par champ documenté dans
 * `docs/import-mapping.md`.
 *
 * Principe directeur : ne JAMAIS perdre un produit réel faute d'appariement
 * — un produit sans équivalent dans l'autre langue est importé quand même
 * (traduction unique) et signalé dans le rapport, plutôt qu'ignoré.
 */
import { pairCategoryTrees } from './categories';
import {
  resolveDimension,
  resolveMerv,
  resolvePackSize,
  poundsToGrams,
  dollarsToCents,
} from './mapping';
import { pairProducts, type ManualReviewCandidate } from './pairing';
import type {
  BigCommerceCategory,
  BigCommerceProduct,
  BigCommerceVariant,
  CatalogExport,
  StoreKey,
} from './types';

export interface PlannedImage {
  sourceUrl: string;
  altFr: string | null;
  altEn: string | null;
  width: number | null;
  height: number | null;
  position: number;
}

export interface PlannedVariant {
  sku: string;
  bigcommerceVariantId: string;
  barcode: string | null;
  nominalLabel: string;
  nominalDimensions: { width: number; height: number; depth: number };
  actualDimensions: { width: number; height: number; depth: number };
  merv: number | null;
  packSize: number;
  priceCents: number;
  compareAtPriceCents: number | null;
  costCents: number | null;
  weightGrams: number | null;
  isActive: boolean;
  position: number;
}

export interface PlannedTranslation {
  locale: 'fr' | 'en';
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
}

export interface PlannedProduct {
  bigcommerceProductId: string;
  brandKey: string;
  categoryBigcommerceId: string | null;
  status: 'ACTIVE' | 'DRAFT';
  isFeatured: boolean;
  translations: PlannedTranslation[];
  variants: PlannedVariant[];
  images: PlannedImage[];
}

export interface PlannedBrand {
  key: string;
  bigcommerceBrandId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

export interface PlannedCategory {
  bigcommerceCategoryId: string;
  parentBigcommerceCategoryId: string | null;
  sortOrder: number;
  isActive: boolean;
  translations: Array<{
    locale: 'fr' | 'en';
    name: string;
    slug: string;
    description: string | null;
  }>;
}

export interface ImportPlan {
  brands: PlannedBrand[];
  categories: PlannedCategory[];
  products: PlannedProduct[];
}

export interface DiscrepancyReportData {
  productsWithoutTranslation: Array<{ store: StoreKey; id: number; name: string; url: string }>;
  manualReviewPairs: ManualReviewCandidate[];
  productsWithoutImage: Array<{ bigcommerceProductId: string; name: string }>;
  variantsWithUnrecognizedDimension: Array<{ sku: string; productName: string; raw: string }>;
  duplicateSkus: Array<{ sku: string; keptForProduct: string; ignoredForProducts: string[] }>;
  orphanCategories: { en: BigCommerceCategory[]; fr: BigCommerceCategory[] };
}

function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugFromUrl(url: string, fallbackName: string): string {
  const slug = url.replace(/^\/+|\/+$/g, '');
  return slug || slugify(fallbackName);
}

function sourceId(store: StoreKey, id: number): string {
  return `${store}:${id}`;
}

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/* --------------------------------- Marques -------------------------------- */

function planBrands(catalogExport: CatalogExport): {
  brands: PlannedBrand[];
  brandNameOf: (store: StoreKey, product: BigCommerceProduct) => string | null;
} {
  const brandNameById: Record<StoreKey, Map<number, string>> = { en: new Map(), fr: new Map() };
  const byKey = new Map<string, PlannedBrand>();
  // Filet de sécurité : produit BigCommerce sans `brand_id` du tout.
  byKey.set('', {
    key: '',
    bigcommerceBrandId: 'none:0',
    name: 'Sans marque (BigCommerce)',
    slug: 'sans-marque',
    logoUrl: null,
  });

  for (const store of ['en', 'fr'] as const) {
    for (const brand of catalogExport.stores[store].brands) {
      brandNameById[store].set(brand.id, brand.name);
      const key = brand.name.trim().toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          bigcommerceBrandId: sourceId(store, brand.id),
          name: brand.name,
          slug: slugFromUrl(brand.custom_url?.url ?? '', brand.name),
          logoUrl: brand.image_url || null,
        });
      }
    }
  }

  return {
    brands: [...byKey.values()],
    brandNameOf: (store, product) => {
      if (product.brand_id === null) return null;
      return brandNameById[store].get(product.brand_id) ?? null;
    },
  };
}

/* -------------------------------- Catégories ------------------------------ */

function planCategories(catalogExport: CatalogExport): {
  categories: PlannedCategory[];
  categoryKeyOf: (store: StoreKey, originalId: number) => string | null;
  orphanCategories: { en: BigCommerceCategory[]; fr: BigCommerceCategory[] };
  categoryPairing: ReturnType<typeof pairCategoryTrees>;
} {
  const categoryPairing = pairCategoryTrees(
    catalogExport.stores.en.categories,
    catalogExport.stores.fr.categories,
  );
  const { pairs, orphans } = categoryPairing;

  const keyByOriginal = new Map<string, string>();
  for (const pair of pairs) {
    const canonical = pair.en ? sourceId('en', pair.en.id) : sourceId('fr', pair.fr!.id);
    if (pair.en) keyByOriginal.set(sourceId('en', pair.en.id), canonical);
    if (pair.fr) keyByOriginal.set(sourceId('fr', pair.fr.id), canonical);
  }
  for (const category of orphans.en)
    keyByOriginal.set(sourceId('en', category.id), sourceId('en', category.id));
  for (const category of orphans.fr)
    keyByOriginal.set(sourceId('fr', category.id), sourceId('fr', category.id));

  function categoryKeyOf(store: StoreKey, originalId: number): string | null {
    if (originalId === 0) return null;
    return keyByOriginal.get(sourceId(store, originalId)) ?? null;
  }

  const categories: PlannedCategory[] = [];
  for (const pair of pairs) {
    const translations: PlannedCategory['translations'] = [];
    if (pair.en) {
      translations.push({
        locale: 'en',
        name: pair.en.name,
        slug: slugFromUrl(pair.en.custom_url.url, pair.en.name),
        description: stripHtml(pair.en.description),
      });
    }
    if (pair.fr) {
      translations.push({
        locale: 'fr',
        name: pair.fr.name,
        slug: slugFromUrl(pair.fr.custom_url.url, pair.fr.name),
        description: stripHtml(pair.fr.description),
      });
    }
    const reference = pair.en ?? pair.fr!;
    categories.push({
      bigcommerceCategoryId: pair.en ? sourceId('en', pair.en.id) : sourceId('fr', pair.fr!.id),
      parentBigcommerceCategoryId: categoryKeyOf(
        pair.en ? 'en' : 'fr',
        pair.en ? pair.en.parent_id : pair.fr!.parent_id,
      ),
      sortOrder: reference.sort_order,
      isActive: Boolean((pair.en?.is_visible ?? false) || (pair.fr?.is_visible ?? false)),
      translations,
    });
  }
  for (const store of ['en', 'fr'] as const) {
    for (const category of orphans[store]) {
      categories.push({
        bigcommerceCategoryId: sourceId(store, category.id),
        parentBigcommerceCategoryId: categoryKeyOf(store, category.parent_id),
        sortOrder: category.sort_order,
        isActive: category.is_visible,
        translations: [
          {
            locale: store,
            name: category.name,
            slug: slugFromUrl(category.custom_url.url, category.name),
            description: stripHtml(category.description),
          },
        ],
      });
    }
  }

  return { categories, categoryKeyOf, orphanCategories: orphans, categoryPairing };
}

/* --------------------------------- Variantes ------------------------------- */

interface VariantBuildResult {
  variants: PlannedVariant[];
  unrecognized: Array<{ sku: string; productName: string; raw: string }>;
}

function buildVariant(
  productName: string,
  customFields: BigCommerceProduct['custom_fields'],
  variant: BigCommerceVariant,
  store: StoreKey,
  position: number,
  fallbackPriceCents: number | null,
  fallbackCompareAtCents: number | null,
  fallbackCostCents: number | null,
  fallbackWeightGrams: number | null,
): {
  variant: PlannedVariant | null;
  unrecognized?: { sku: string; productName: string; raw: string };
} {
  const resolution = resolveDimension(productName, variant.option_values, customFields);
  if (!resolution || !resolution.size) {
    return resolution
      ? { variant: null, unrecognized: { sku: variant.sku, productName, raw: resolution.raw } }
      : { variant: null };
  }

  const merv = resolveMerv(productName, variant.option_values, customFields);
  const packSize = resolvePackSize(productName, variant.sku, variant.option_values, customFields);

  return {
    variant: {
      sku: variant.sku,
      bigcommerceVariantId: sourceId(store, variant.id),
      barcode: variant.upc || null,
      nominalLabel: resolution.size.nominal,
      nominalDimensions: { ...resolution.size.nominalDimensions },
      actualDimensions: { ...resolution.size.actualDimensions },
      merv,
      packSize,
      priceCents: dollarsToCents(variant.price) ?? fallbackPriceCents ?? 0,
      compareAtPriceCents: fallbackCompareAtCents,
      costCents: fallbackCostCents,
      weightGrams: poundsToGrams(variant.weight) ?? fallbackWeightGrams,
      isActive: true,
      position,
    },
  };
}

function buildVariantsForProduct(product: BigCommerceProduct, store: StoreKey): VariantBuildResult {
  const unrecognized: VariantBuildResult['unrecognized'] = [];
  const variants: PlannedVariant[] = [];
  const fallbackPriceCents = dollarsToCents(product.price);
  const fallbackCompareAtCents = dollarsToCents(product.retail_price);
  const fallbackCostCents = dollarsToCents(product.cost_price);
  const fallbackWeightGrams = poundsToGrams(product.weight);

  product.variants.forEach((variant, index) => {
    const result = buildVariant(
      product.name,
      product.custom_fields,
      variant,
      store,
      index,
      fallbackPriceCents,
      fallbackCompareAtCents,
      fallbackCostCents,
      fallbackWeightGrams,
    );
    if (result.variant) variants.push(result.variant);
    if (result.unrecognized) unrecognized.push(result.unrecognized);
  });

  return { variants, unrecognized };
}

/** Fusionne les variantes en/fr d'un même produit apparié, dédupliquées par SKU. */
function mergeVariants(en: VariantBuildResult, fr: VariantBuildResult): VariantBuildResult {
  const bySku = new Map<string, PlannedVariant>();
  for (const variant of [...fr.variants, ...en.variants]) bySku.set(variant.sku, variant);
  return {
    variants: [...bySku.values()],
    unrecognized: [...en.unrecognized, ...fr.unrecognized],
  };
}

function buildImages(
  product: BigCommerceProduct,
  altOther: string | null,
  locale: 'fr' | 'en',
): PlannedImage[] {
  return product.images
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((image, index) => ({
      sourceUrl: image.url_zoom || image.url_standard,
      altFr: locale === 'fr' ? image.description || null : altOther,
      altEn: locale === 'en' ? image.description || null : altOther,
      width: null,
      height: null,
      position: index,
    }));
}

/* --------------------------------- Produits -------------------------------- */

export function buildImportPlan(catalogExport: CatalogExport): {
  plan: ImportPlan;
  discrepancies: DiscrepancyReportData;
  productPairing: ReturnType<typeof pairProducts>;
  categoryPairing: ReturnType<typeof pairCategoryTrees>;
} {
  const { brands, brandNameOf } = planBrands(catalogExport);
  const { categories, categoryKeyOf, orphanCategories, categoryPairing } =
    planCategories(catalogExport);

  const pairing = pairProducts(
    catalogExport.stores.en.products,
    catalogExport.stores.fr.products,
    brandNameOf,
  );

  const products: PlannedProduct[] = [];
  const variantsWithUnrecognizedDimension: DiscrepancyReportData['variantsWithUnrecognizedDimension'] =
    [];
  const productsWithoutImage: DiscrepancyReportData['productsWithoutImage'] = [];

  function translationOf(product: BigCommerceProduct, locale: 'fr' | 'en'): PlannedTranslation {
    return {
      locale,
      name: product.name,
      slug: slugFromUrl(product.custom_url.url, product.name),
      description: stripHtml(product.description),
      shortDescription: null,
      metaTitle: product.page_title || null,
      metaDescription: product.meta_description || null,
    };
  }

  function primaryCategoryOf(product: BigCommerceProduct, store: StoreKey): string | null {
    for (const categoryId of product.categories) {
      const key = categoryKeyOf(store, categoryId);
      if (key) return key;
    }
    return null;
  }

  function finalize(
    bigcommerceProductId: string,
    built: {
      brandKey: string | null;
      categoryBigcommerceId: string | null;
      isVisible: boolean;
      isFeatured: boolean;
      translations: PlannedTranslation[];
      variantResult: VariantBuildResult;
      images: PlannedImage[];
    },
  ): void {
    variantsWithUnrecognizedDimension.push(...built.variantResult.unrecognized);
    if (built.images.length === 0) {
      productsWithoutImage.push({ bigcommerceProductId, name: built.translations[0]!.name });
    }
    products.push({
      bigcommerceProductId,
      brandKey: built.brandKey ?? '',
      categoryBigcommerceId: built.categoryBigcommerceId,
      status: built.isVisible ? 'ACTIVE' : 'DRAFT',
      isFeatured: built.isFeatured,
      translations: built.translations,
      variants: built.variantResult.variants,
      images: built.images,
    });
  }

  // --- Paires bilingues fiables (SKU partagé).
  for (const pair of pairing.pairs) {
    const enVariants = buildVariantsForProduct(pair.en, 'en');
    const frVariants = buildVariantsForProduct(pair.fr, 'fr');
    const enImages = buildImages(pair.en, null, 'en');
    const frImages = buildImages(pair.fr, null, 'fr');

    finalize(sourceId('en', pair.en.id), {
      brandKey: brandNameOf('en', pair.en)?.trim().toLowerCase() ?? null,
      categoryBigcommerceId: primaryCategoryOf(pair.en, 'en') ?? primaryCategoryOf(pair.fr, 'fr'),
      isVisible: pair.en.is_visible || pair.fr.is_visible,
      isFeatured: pair.en.is_featured || pair.fr.is_featured,
      translations: [translationOf(pair.en, 'en'), translationOf(pair.fr, 'fr')],
      variantResult: mergeVariants(enVariants, frVariants),
      images: [...enImages, ...frImages],
    });
  }

  // --- Produits sans équivalent (unmatched + candidats de revue manuelle) :
  // importés en unilingue plutôt que perdus, signalés au rapport.
  const singleLocale: Array<{ store: StoreKey; product: BigCommerceProduct }> = [
    ...pairing.unmatched.en.map((product) => ({ store: 'en' as const, product })),
    ...pairing.unmatched.fr.map((product) => ({ store: 'fr' as const, product })),
    ...pairing.manualReview.map((candidate) => ({ store: 'en' as const, product: candidate.en })),
    ...pairing.manualReview.map((candidate) => ({ store: 'fr' as const, product: candidate.fr })),
  ];
  const seenSingleLocale = new Set<string>();
  const trueUnmatchedIds = {
    en: new Set(pairing.unmatched.en.map((product) => product.id)),
    fr: new Set(pairing.unmatched.fr.map((product) => product.id)),
  };
  const productsWithoutTranslation: DiscrepancyReportData['productsWithoutTranslation'] = [];

  for (const { store, product } of singleLocale) {
    const key = sourceId(store, product.id);
    if (seenSingleLocale.has(key)) continue;
    seenSingleLocale.add(key);

    // Distinct de `manualReviewPairs` : uniquement les produits sans AUCUN
    // candidat plausible (les candidats ont leur propre section du rapport).
    if (trueUnmatchedIds[store].has(product.id)) {
      productsWithoutTranslation.push({
        store,
        id: product.id,
        name: product.name,
        url: product.custom_url.url,
      });
    }

    const variantResult = buildVariantsForProduct(product, store);
    const images = buildImages(product, null, store);
    finalize(key, {
      brandKey: brandNameOf(store, product)?.trim().toLowerCase() ?? null,
      categoryBigcommerceId: primaryCategoryOf(product, store),
      isVisible: product.is_visible,
      isFeatured: product.is_featured,
      translations: [translationOf(product, store)],
      variantResult,
      images,
    });
  }

  // --- Dédoublonnage global des SKU (un SKU ne peut appartenir qu'à UN produit).
  const skuOwner = new Map<string, string>();
  const duplicateSkus: DiscrepancyReportData['duplicateSkus'] = [];
  for (const product of products) {
    product.variants = product.variants.filter((variant) => {
      const owner = skuOwner.get(variant.sku);
      if (!owner) {
        skuOwner.set(variant.sku, product.bigcommerceProductId);
        return true;
      }
      if (owner === product.bigcommerceProductId) return true; // même produit, ok
      let entry = duplicateSkus.find((d) => d.sku === variant.sku);
      if (!entry) {
        entry = { sku: variant.sku, keptForProduct: owner, ignoredForProducts: [] };
        duplicateSkus.push(entry);
      }
      if (!entry.ignoredForProducts.includes(product.bigcommerceProductId)) {
        entry.ignoredForProducts.push(product.bigcommerceProductId);
      }
      return false;
    });
  }

  return {
    plan: { brands, categories, products },
    discrepancies: {
      productsWithoutTranslation,
      manualReviewPairs: pairing.manualReview,
      productsWithoutImage,
      variantsWithUnrecognizedDimension,
      duplicateSkus,
      orphanCategories,
    },
    productPairing: pairing,
    categoryPairing,
  };
}
