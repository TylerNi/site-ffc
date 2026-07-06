/**
 * Appariement fr ↔ en des produits (tâche 08 §2). Un produit = une fiche
 * `Product` + deux `ProductTranslation`.
 *
 * 1. Par SKU (fiable) : un SKU de variante partagé entre les deux vitrines
 *    identifie la même fiche produit — appariement automatique.
 * 2. Le reste passe par une heuristique (dimensions communes + marque
 *    similaire + recouvrement du nom) qui ne fait QUE proposer des candidats
 *    — jamais d'appariement automatique incertain. Les candidats et les
 *    produits sans aucune correspondance vont dans le rapport d'écarts pour
 *    revue manuelle.
 */
import { resolveDimension } from './mapping';
import type { BigCommerceProduct } from './types';

export interface SkuMatchedPair {
  en: BigCommerceProduct;
  fr: BigCommerceProduct;
  matchedBy: 'sku';
  sharedSkus: string[];
}

export interface ManualReviewCandidate {
  en: BigCommerceProduct;
  fr: BigCommerceProduct;
  score: number;
  reasons: string[];
}

export interface PairingResult {
  pairs: SkuMatchedPair[];
  /** Produits en/fr n'ayant NI correspondance SKU NI candidat plausible. */
  unmatched: { en: BigCommerceProduct[]; fr: BigCommerceProduct[] };
  /** Candidats heuristiques — revue manuelle requise avant import. */
  manualReview: ManualReviewCandidate[];
}

function productSkus(product: BigCommerceProduct): string[] {
  const skus = product.variants.length > 0 ? product.variants.map((v) => v.sku) : [product.sku];
  return skus.filter((sku): sku is string => Boolean(sku));
}

function normalizeWords(name: string): Set<string> {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'le',
    'la',
    'les',
    'de',
    'du',
    'des',
    'pour',
    'for',
    'filter',
    'filtre',
    'furnace',
    'fournaise',
  ]);
  return new Set(
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !stopWords.has(word)),
  );
}

function wordOverlapRatio(a: string, b: string): number {
  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared / Math.max(wordsA.size, wordsB.size);
}

function dimensionLabels(product: BigCommerceProduct): Set<string> {
  const labels = new Set<string>();
  for (const variant of product.variants) {
    const resolution = resolveDimension(product.name, variant.option_values, product.custom_fields);
    if (resolution) labels.add(resolution.raw);
  }
  return labels;
}

const MANUAL_REVIEW_THRESHOLD = 1.5;
const MAX_CANDIDATES_PER_PRODUCT = 3;

/**
 * @param brandNameOf résout le nom de marque d'un produit dans sa vitrine
 *   (les `brand_id` ne sont PAS comparables entre les deux boutiques
 *   BigCommerce séparées — seul le nom l'est).
 */
export function pairProducts(
  enProducts: BigCommerceProduct[],
  frProducts: BigCommerceProduct[],
  brandNameOf: (store: 'en' | 'fr', product: BigCommerceProduct) => string | null,
): PairingResult {
  const frBySku = new Map<string, BigCommerceProduct>();
  for (const product of frProducts) {
    for (const sku of productSkus(product)) frBySku.set(sku, product);
  }

  const pairs: SkuMatchedPair[] = [];
  const matchedFrIds = new Set<number>();
  const remainingEn: BigCommerceProduct[] = [];

  for (const enProduct of enProducts) {
    const skus = productSkus(enProduct);
    const matches = new Set<BigCommerceProduct>();
    for (const sku of skus) {
      const match = frBySku.get(sku);
      if (match) matches.add(match);
    }

    if (matches.size === 1) {
      const [frProduct] = [...matches];
      pairs.push({
        en: enProduct,
        fr: frProduct!,
        matchedBy: 'sku',
        sharedSkus: skus.filter((sku) => productSkus(frProduct!).includes(sku)),
      });
      matchedFrIds.add(frProduct!.id);
    } else {
      // 0 correspondance (à apparier par heuristique) ou >1 (ambigu → revue manuelle).
      remainingEn.push(enProduct);
    }
  }

  const remainingFr = frProducts.filter((product) => !matchedFrIds.has(product.id));

  const manualReview: ManualReviewCandidate[] = [];
  const candidatesByEn = new Map<number, ManualReviewCandidate[]>();

  for (const enProduct of remainingEn) {
    const enDims = dimensionLabels(enProduct);
    const enBrand = brandNameOf('en', enProduct)?.toLowerCase() ?? null;
    const candidates: ManualReviewCandidate[] = [];

    for (const frProduct of remainingFr) {
      const frDims = dimensionLabels(frProduct);
      const frBrand = brandNameOf('fr', frProduct)?.toLowerCase() ?? null;
      const reasons: string[] = [];
      let score = 0;

      const sharedDims = [...enDims].filter((label) => frDims.has(label));
      if (sharedDims.length > 0) {
        score += 2;
        reasons.push(`dimensions communes (${sharedDims.join(', ')})`);
      }
      if (enBrand && frBrand && enBrand === frBrand) {
        score += 1.5;
        reasons.push(`même marque (${enBrand})`);
      }
      const overlap = wordOverlapRatio(enProduct.name, frProduct.name);
      if (overlap > 0) {
        score += overlap;
        reasons.push(`recouvrement du nom (${(overlap * 100).toFixed(0)}%)`);
      }

      if (score >= MANUAL_REVIEW_THRESHOLD) {
        candidates.push({ en: enProduct, fr: frProduct, score, reasons });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 0) {
      candidatesByEn.set(enProduct.id, candidates.slice(0, MAX_CANDIDATES_PER_PRODUCT));
      manualReview.push(...candidates.slice(0, MAX_CANDIDATES_PER_PRODUCT));
    }
  }

  const unmatchedEn = remainingEn.filter((product) => !candidatesByEn.has(product.id));
  const candidateFrIds = new Set(manualReview.map((candidate) => candidate.fr.id));
  const unmatchedFr = remainingFr.filter((product) => !candidateFrIds.has(product.id));

  return { pairs, unmatched: { en: unmatchedEn, fr: unmatchedFr }, manualReview };
}
