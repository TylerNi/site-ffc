import { z } from 'zod';
import { type FilterDimensions, NOMINAL_FILTER_SIZES, type NominalFilterSize } from './filters';

/**
 * Normalisation et équivalences de dimensions de filtres — cœur de l'UX de
 * recherche (tâche 06). Fonctions PURES, partagées par l'API (recherche,
 * filtres), la vitrine et le mobile, et validées par des tests unitaires.
 *
 * Deux problèmes métier :
 *   1. Les clients écrivent une même taille de mille façons : « 16x25x1 »,
 *      « 16 x 25 x 1 », « 16-25-1 », « 16*25*1 », « 16 by 25 by 1 ». Toutes
 *      doivent mener au même résultat.
 *   2. Nominal vs réel : un filtre « 16x25x1 » mesure réellement ~15¾ x 24¾ x ¾ po.
 *      Une recherche « 15 3/4 x 24 3/4 » doit retrouver le « 16x25x1 ».
 *   Bonus : les deux premières dimensions sont interchangeables (un filtre se
 *   pose dans les deux sens) — « 25x16x1 » ≡ « 16x25x1 ».
 */

/** Séparateurs de dimensions acceptés : x, ×, *, « by », « par ». */
const DIMENSION_SEPARATOR = /\s*(?:x|×|\*|by|par)\s*/i;

/** Marques de pouces à effacer avant analyse (« 19 3/4" x 20 1/2" »). */
const INCH_MARKS = /["″”]|''|’’/g;

/** Jeton de dimension repérable DANS une requête plus large (« filtre 16x25x1 »).
 *  Exige un séparateur de type « x » (pas le tiret, pour ne pas capturer
 *  « merv-11 ») et 2 ou 3 composantes numériques (entières, décimales,
 *  fractions pures « 7/8 » ou nombres mixtes « 15 3/4 »). */
const DIMENSION_TOKEN =
  /\b\d{1,2}(?:[.,]\d+)?(?:\s\d+\/\d+|\/\d+)?\s*(?:x|×|\*|by|par)\s*\d{1,2}(?:[.,]\d+)?(?:\s\d+\/\d+|\/\d+)?(?:\s*(?:x|×|\*|by|par)\s*\d{1,2}(?:[.,]\d+)?(?:\s\d+\/\d+|\/\d+)?)?\b/i;

/** Tolérances de correspondance : quasi exacte sur le nominal, plus lâche sur
 *  les dimensions réelles (les fiches produits arrondissent au 1/8 de pouce). */
const NOMINAL_TOLERANCE = 0.01;
const ACTUAL_TOLERANCE = 0.15;

/** Dimension analysée depuis une saisie libre. `depth` est null si l'utilisateur
 *  n'a fourni que deux composantes (ex. « 16x25 » → toutes profondeurs). */
export interface ParsedDimension {
  readonly width: number;
  readonly height: number;
  readonly depth: number | null;
}

export const parsedDimensionSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive().nullable(),
});

/** Analyse une composante : entier, décimale (« 15.75 »/« 15,75 »),
 *  fraction (« 3/4 ») ou nombre mixte (« 15 3/4 »). */
function parseComponent(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;

  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const denominator = Number(mixed[3]);
    if (denominator === 0) return null;
    return Number(mixed[1]) + Number(mixed[2]) / denominator;
  }

  const fraction = s.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return null;
    return Number(fraction[1]) / denominator;
  }

  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/** Découpe une saisie en composantes : séparateurs « x » d'abord, tiret en
 *  repli (« 16-25-1 ») lorsqu'aucun séparateur « x » n'est présent. */
function splitComponents(raw: string): string[] {
  const trimmed = raw.trim();
  if (DIMENSION_SEPARATOR.test(trimmed)) {
    return trimmed.split(DIMENSION_SEPARATOR);
  }
  if (trimmed.includes('-')) {
    return trimmed.split('-');
  }
  return [trimmed];
}

/**
 * Analyse une dimension écrite dans n'importe quel format courant.
 * Retourne null si la saisie n'est pas une dimension valide (2 ou 3
 * composantes strictement positives).
 */
export function parseDimensionInput(raw: string): ParsedDimension | null {
  if (typeof raw !== 'string') return null;
  const parts = splitComponents(raw.replace(INCH_MARKS, ''));
  if (parts.length < 2 || parts.length > 3) return null;

  const numbers = parts.map(parseComponent);
  if (numbers.some((n) => n === null || n <= 0)) return null;
  const [width, height, depth] = numbers as number[];
  if (width === undefined || height === undefined) return null;

  return { width, height, depth: depth ?? null };
}

/** true si la saisie EST une dimension (utilisé pour aiguiller la recherche). */
export function looksLikeDimension(raw: string): boolean {
  return parseDimensionInput(raw) !== null;
}

/**
 * Extrait la première dimension trouvée DANS une requête libre
 * (« filtre 16x25x1 merv 11 » → « 16x25x1 ») et retourne aussi le texte
 * résiduel (« filtre merv 11 »). Utile à la recherche mixte texte + taille.
 */
export function extractDimension(query: string): { dimension: string; rest: string } | null {
  if (typeof query !== 'string') return null;
  const normalized = query.replace(INCH_MARKS, '');
  const match = normalized.match(DIMENSION_TOKEN);
  if (match) {
    const dimension = match[0];
    const rest = (
      normalized.slice(0, match.index) + normalized.slice((match.index ?? 0) + dimension.length)
    )
      .replace(/\s+/g, ' ')
      .trim();
    return { dimension, rest };
  }
  // Requête entièrement composée d'une dimension au tiret (« 16-25-1 »).
  if (looksLikeDimension(normalized)) {
    return { dimension: normalized.trim(), rest: '' };
  }
  return null;
}

/** Formate un nombre sans zéros superflus : 16 → « 16 », 15.75 → « 15.75 ». */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** Libellé canonique d'une dimension analysée (« 16x25x1 » ou « 16x25 »). */
export function canonicalDimensionLabel(parsed: ParsedDimension): string {
  const base = `${formatNumber(parsed.width)}x${formatNumber(parsed.height)}`;
  return parsed.depth === null ? base : `${base}x${formatNumber(parsed.depth)}`;
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/** Les deux premières dimensions correspondent-elles (nominal OU réel, dans un
 *  sens OU l'autre) ? */
function facePairMatches(size: NominalFilterSize, width: number, height: number): boolean {
  const nominalMatch = (d: FilterDimensions): boolean =>
    (near(d.width, width, NOMINAL_TOLERANCE) && near(d.height, height, NOMINAL_TOLERANCE)) ||
    (near(d.width, height, NOMINAL_TOLERANCE) && near(d.height, width, NOMINAL_TOLERANCE));
  const actualMatch = (d: FilterDimensions): boolean =>
    (near(d.width, width, ACTUAL_TOLERANCE) && near(d.height, height, ACTUAL_TOLERANCE)) ||
    (near(d.width, height, ACTUAL_TOLERANCE) && near(d.height, width, ACTUAL_TOLERANCE));
  return nominalMatch(size.nominalDimensions) || actualMatch(size.actualDimensions);
}

/** La profondeur correspond-elle (nominal exact OU réel tolérant) ? */
function depthMatches(size: NominalFilterSize, depth: number): boolean {
  return (
    near(size.nominalDimensions.depth, depth, NOMINAL_TOLERANCE) ||
    near(size.actualDimensions.depth, depth, ACTUAL_TOLERANCE)
  );
}

/** Une taille du référentiel correspond-elle à la dimension analysée ? */
function sizeMatches(size: NominalFilterSize, parsed: ParsedDimension): boolean {
  if (!facePairMatches(size, parsed.width, parsed.height)) return false;
  return parsed.depth === null || depthMatches(size, parsed.depth);
}

/** Résultat de résolution d'équivalences pour une saisie de dimension. */
export interface DimensionEquivalence {
  /** Saisie d'origine, telle quelle. */
  readonly input: string;
  readonly parsed: ParsedDimension;
  /** Libellé canonique (taille référencée si trouvée, sinon saisie formatée). */
  readonly canonical: string;
  /** Libellés nominaux du référentiel équivalents (nominal ↔ réel, orientation
   *  indifférente) — l'ensemble à interroger en base. */
  readonly labels: readonly string[];
  /** Tailles nominales complètes correspondantes. */
  readonly sizes: readonly NominalFilterSize[];
}

/**
 * Pour une dimension écrite librement, retourne les tailles nominales
 * équivalentes/compatibles du référentiel `@ffc/core` (nominal ↔ réel,
 * profondeur optionnelle, orientation interchangeable).
 *
 * Retourne null si la saisie n'est pas une dimension analysable.
 */
export function dimensionEquivalents(input: string): DimensionEquivalence | null {
  const parsed = parseDimensionInput(input);
  if (!parsed) return null;

  const sizes = NOMINAL_FILTER_SIZES.filter((size) => sizeMatches(size, parsed));
  const labels = [...new Set(sizes.map((size) => size.nominal))];
  const canonical = sizes[0]?.nominal ?? canonicalDimensionLabel(parsed);

  return { input, parsed, canonical, labels, sizes };
}
