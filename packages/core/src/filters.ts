import { z } from 'zod';

/** Dimensions d'un filtre, en pouces (largeur × hauteur × épaisseur). */
export interface FilterDimensions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export const filterDimensionsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
});

/**
 * Taille nominale de filtre : le libellé commercial (ex. « 16x25x1 »)
 * et les dimensions réelles correspondantes. Pour les tailles standard,
 * les réelles sont inférieures aux nominales (généralement de 1/4 à
 * 1/2 po) ; pour les tailles « exactes » (libellé fractionnaire, ex.
 * « 20.25x25.38x5.25 »), le libellé EST la dimension réelle.
 */
export interface NominalFilterSize {
  /** Libellé nominal, ex. « 16x25x1 ». */
  readonly nominal: string;
  readonly nominalDimensions: FilterDimensions;
  /** Dimensions réelles typiques du produit. */
  readonly actualDimensions: FilterDimensions;
}

/** Libellé nominal attendu : LxHxP, entiers ou décimales (ex. « 16x25x1 »,
 *  « 20.25x25.38x5.25 »). */
export const nominalSizeLabelSchema = z
  .string()
  .regex(
    /^\d{1,2}(?:\.\d{1,2})?x\d{1,2}(?:\.\d{1,2})?x\d{1,2}(?:\.\d{1,2})?$/i,
    'Format attendu : LxHxP, ex. 16x25x1',
  );

function defineSize(
  nominal: readonly [number, number, number],
  actual: readonly [number, number, number],
): NominalFilterSize {
  return {
    nominal: `${nominal[0]}x${nominal[1]}x${nominal[2]}`,
    nominalDimensions: { width: nominal[0], height: nominal[1], depth: nominal[2] },
    actualDimensions: { width: actual[0], height: actual[1], depth: actual[2] },
  };
}

/** Profondeurs réelles d'usage industriel pour les épaisseurs nominales
 *  standard (1 po → 3/4, 2 po → 1 3/4, 4 po → 3 3/4, 5 po → 4 3/8). */
const STANDARD_ACTUAL_DEPTHS: Readonly<Record<number, number>> = {
  1: 0.75,
  2: 1.75,
  4: 3.75,
  5: 4.375,
};

/** Taille standard : réel = nominal − 1/4 po (profondeur selon l'usage). */
function standardSize(nominal: readonly [number, number, number]): NominalFilterSize {
  return defineSize(nominal, [
    nominal[0] - 0.25,
    nominal[1] - 0.25,
    STANDARD_ACTUAL_DEPTHS[nominal[2]] ?? nominal[2] - 0.25,
  ]);
}

/** Taille « exacte » : le libellé fractionnaire est la dimension réelle. */
function exactSize(dimensions: readonly [number, number, number]): NominalFilterSize {
  return defineSize(dimensions, dimensions);
}

/**
 * Tailles nominales et leurs dimensions réelles typiques. Liste enrichie
 * depuis le catalogue réel BigCommerce (export du 2026-07-18, tâche 08) —
 * une taille absente d'ici n'est jamais fabriquée à l'import : elle est
 * signalée « dimension non reconnue » et s'ajoute ici après vérification.
 */
export const NOMINAL_FILTER_SIZES: readonly NominalFilterSize[] = [
  /* --------------------------- 7/8 po (exactes) --------------------------- */
  exactSize([7.5, 13.5, 0.88]),
  exactSize([8.75, 24, 0.88]),
  exactSize([15.5, 13.5, 0.88]),

  /* -------------------------------- 1 po --------------------------------- */
  standardSize([7, 20, 1]),
  standardSize([10, 10, 1]),
  standardSize([10, 20, 1]),
  standardSize([10, 24, 1]),
  standardSize([10, 25, 1]),
  standardSize([12, 12, 1]),
  standardSize([12, 16, 1]),
  standardSize([12, 20, 1]),
  standardSize([12, 24, 1]),
  standardSize([12, 25, 1]),
  standardSize([14, 20, 1]),
  standardSize([14, 24, 1]),
  standardSize([14, 25, 1]),
  standardSize([15, 20, 1]),
  standardSize([15, 25, 1]),
  standardSize([16, 16, 1]),
  standardSize([16, 20, 1]),
  standardSize([16, 24, 1]),
  standardSize([16, 25, 1]),
  standardSize([18, 20, 1]),
  standardSize([18, 24, 1]),
  standardSize([18, 25, 1]),
  standardSize([20, 20, 1]),
  standardSize([20, 24, 1]),
  standardSize([20, 25, 1]),
  standardSize([20, 30, 1]),
  standardSize([21, 22, 1]),
  standardSize([22, 22, 1]),
  standardSize([24, 24, 1]),
  standardSize([25, 25, 1]),

  /* ------------------------- 1 3/4 po (exactes) --------------------------- */
  exactSize([19.5, 29.25, 1.75]),
  exactSize([28.5, 31.5, 1.75]),

  /* -------------------------------- 2 po --------------------------------- */
  exactSize([7.5, 31.5, 2]),
  standardSize([10, 20, 2]),
  standardSize([12, 20, 2]),
  standardSize([12, 24, 2]),
  standardSize([14, 20, 2]),
  standardSize([14, 25, 2]),
  standardSize([15, 20, 2]),
  standardSize([15, 25, 2]),
  standardSize([16, 16, 2]),
  standardSize([16, 20, 2]),
  standardSize([16, 24, 2]),
  standardSize([16, 25, 2]),
  standardSize([18, 20, 2]),
  standardSize([18, 24, 2]),
  standardSize([18, 25, 2]),
  standardSize([20, 20, 2]),
  standardSize([20, 24, 2]),
  standardSize([20, 25, 2]),
  standardSize([20, 30, 2]),
  standardSize([24, 24, 2]),
  standardSize([25, 25, 2]),

  /* ---------------------- 3 à 3 3/4 po (exactes) -------------------------- */
  exactSize([15.75, 24.25, 3]),
  exactSize([13.5, 24, 3.75]),
  exactSize([17, 24, 3.75]),

  /* -------------------------------- 4 po --------------------------------- */
  standardSize([10, 20, 4]),
  standardSize([12, 24, 4]),
  standardSize([16, 20, 4]),
  standardSize([16, 24, 4]),
  standardSize([16, 25, 4]),
  standardSize([18, 24, 4]),
  standardSize([20, 20, 4]),
  standardSize([20, 24, 4]),
  standardSize([20, 25, 4]),
  standardSize([24, 24, 4]),
  standardSize([25, 25, 4]),
  standardSize([25, 29, 4]),

  /* ------------------------- 4 7/8 po (exactes) --------------------------- */
  exactSize([15.75, 24.25, 4.88]),
  exactSize([19.75, 20.5, 4.88]),
  exactSize([19.75, 24.25, 4.88]),

  /* -------------------------------- 5 po --------------------------------- */
  standardSize([16, 20, 5]),
  standardSize([16, 25, 5]),
  standardSize([20, 20, 5]),
  standardSize([20, 25, 5]),

  /* ------------------------- 5 1/4 po (exactes) --------------------------- */
  exactSize([15.38, 25.5, 5.25]),
  exactSize([20.25, 20.75, 5.25]),
  exactSize([20.25, 25.38, 5.25]),
];

/** Retrouve une taille nominale par son libellé (ex. « 16x25x1 »). */
export function findNominalSize(nominal: string): NominalFilterSize | undefined {
  const normalized = nominal.trim().toLowerCase();
  return NOMINAL_FILTER_SIZES.find((size) => size.nominal === normalized);
}
