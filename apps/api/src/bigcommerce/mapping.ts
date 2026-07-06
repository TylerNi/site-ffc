/**
 * Extraction de taille/MERV/format de boîte depuis les données BigCommerce
 * (options de variante > champs personnalisés > nom du produit, dans cet
 * ordre de préférence) — tâche 08 §3. Fonctions PURES, testées isolément.
 *
 * Normalisation des dimensions déléguée à `@ffc/core` (mêmes règles que la
 * recherche catalogue de la tâche 06) : une taille qui n'est pas dans
 * `NOMINAL_FILTER_SIZES` n'est PAS fabriquée — elle est signalée comme
 * « dimension non reconnue » (critère d'acceptation de la tâche 08).
 */
import {
  canonicalDimensionLabel,
  extractDimension,
  findNominalSize,
  mervValueSchema,
  parseDimensionInput,
  type NominalFilterSize,
} from '@ffc/core';
import type { BigCommerceCustomField, BigCommerceVariantOptionValue } from './types';

function findOptionValue(
  optionValues: BigCommerceVariantOptionValue[],
  namePattern: RegExp,
): string | null {
  return optionValues.find((option) => namePattern.test(option.option_display_name))?.label ?? null;
}

function findCustomField(fields: BigCommerceCustomField[], namePattern: RegExp): string | null {
  return fields.find((field) => namePattern.test(field.name))?.value ?? null;
}

const SIZE_OPTION_PATTERN = /size|dimension|taille|format\s*du\s*filtre/i;
const MERV_PATTERN = /merv/i;
const PACK_OPTION_PATTERN = /pack|box|bo[iî]te|format\s*(de\s*)?vente|quantit/i;
const PACK_TEXT_PATTERN =
  /\b(?:box|pack)\s*of\s*(\d{1,3})\b|\((\d{1,3})[\s-]*pack\)|bo[iî]te\s*de\s*(\d{1,3})/i;

export interface DimensionResolution {
  raw: string;
  size: NominalFilterSize | null;
}

/**
 * Résout la taille nominale d'une variante. Retourne `size: null` (avec la
 * chaîne brute conservée) quand la dimension repérée ne correspond à aucune
 * taille du référentiel `@ffc/core` — à ne PAS importer telle quelle.
 */
export function resolveDimension(
  productName: string,
  optionValues: BigCommerceVariantOptionValue[],
  customFields: BigCommerceCustomField[],
): DimensionResolution | null {
  const raw =
    findOptionValue(optionValues, SIZE_OPTION_PATTERN) ??
    findCustomField(customFields, SIZE_OPTION_PATTERN) ??
    extractDimension(productName)?.dimension ??
    null;
  if (!raw) return null;

  const parsed = parseDimensionInput(raw);
  if (!parsed || parsed.depth === null) return { raw, size: null };

  const canonical = canonicalDimensionLabel(parsed);
  const size = findNominalSize(canonical) ?? null;
  return { raw: canonical, size };
}

/** Cote MERV (1-20) si repérable et valide ; `null` sinon (ex. pré-filtres). */
export function resolveMerv(
  productName: string,
  optionValues: BigCommerceVariantOptionValue[],
  customFields: BigCommerceCustomField[],
): number | null {
  const raw =
    findOptionValue(optionValues, MERV_PATTERN) ??
    findCustomField(customFields, MERV_PATTERN) ??
    productName.match(/merv\s*-?\s*(\d{1,2})/i)?.[1] ??
    null;
  if (!raw) return null;

  const value = Number.parseInt(raw.replace(/\D+/g, ''), 10);
  const result = mervValueSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Nombre de filtres par unité de vente (« Box of 6 » → 6). Défaut : 1. */
export function resolvePackSize(
  productName: string,
  sku: string,
  optionValues: BigCommerceVariantOptionValue[],
  customFields: BigCommerceCustomField[],
): number {
  const optionRaw =
    findOptionValue(optionValues, PACK_OPTION_PATTERN) ??
    findCustomField(customFields, PACK_OPTION_PATTERN);
  if (optionRaw) {
    const direct = Number.parseInt(optionRaw.replace(/\D+/g, ''), 10);
    if (Number.isFinite(direct) && direct > 0) return direct;
  }

  const match = `${productName} ${sku}`.match(PACK_TEXT_PATTERN);
  const group = match?.[1] ?? match?.[2] ?? match?.[3];
  const value = group ? Number.parseInt(group, 10) : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Poids BigCommerce (livres par défaut) → grammes entiers. */
export function poundsToGrams(pounds: number | null | undefined): number | null {
  if (!pounds || pounds <= 0) return null;
  return Math.round(pounds * 453.59237);
}

/** Dollars (BigCommerce) → cents entiers. */
export function dollarsToCents(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(value * 100);
}
