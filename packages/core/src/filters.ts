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
 * et les dimensions réelles correspondantes, toujours inférieures aux
 * dimensions nominales (généralement de 1/4 à 1/2 po).
 */
export interface NominalFilterSize {
  /** Libellé nominal, ex. « 16x25x1 ». */
  readonly nominal: string;
  readonly nominalDimensions: FilterDimensions;
  /** Dimensions réelles typiques du produit. */
  readonly actualDimensions: FilterDimensions;
}

/** Libellé nominal attendu : LxHxP, ex. « 16x25x1 ». */
export const nominalSizeLabelSchema = z
  .string()
  .regex(/^\d{1,2}x\d{1,2}x\d{1,2}$/i, 'Format attendu : LxHxP, ex. 16x25x1');

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

/**
 * Tailles nominales courantes et leurs dimensions réelles typiques.
 * Liste de départ — sera enrichie avec le catalogue réel (tâche 08) et la
 * table de correspondance des équivalences de tailles (tâche 06).
 */
export const NOMINAL_FILTER_SIZES: readonly NominalFilterSize[] = [
  defineSize([14, 20, 1], [13.75, 19.75, 0.75]),
  defineSize([14, 25, 1], [13.75, 24.75, 0.75]),
  defineSize([16, 20, 1], [15.75, 19.75, 0.75]),
  defineSize([16, 24, 1], [15.75, 23.75, 0.75]),
  defineSize([16, 25, 1], [15.75, 24.75, 0.75]),
  defineSize([18, 24, 1], [17.75, 23.75, 0.75]),
  defineSize([20, 20, 1], [19.75, 19.75, 0.75]),
  defineSize([20, 24, 1], [19.75, 23.75, 0.75]),
  defineSize([20, 25, 1], [19.75, 24.75, 0.75]),
  defineSize([24, 24, 1], [23.75, 23.75, 0.75]),
  defineSize([16, 25, 4], [15.75, 24.75, 3.75]),
  defineSize([20, 25, 4], [19.75, 24.75, 3.75]),
  defineSize([16, 25, 5], [15.75, 24.75, 4.375]),
  defineSize([20, 25, 5], [19.75, 24.75, 4.375]),
];

/** Retrouve une taille nominale par son libellé (ex. « 16x25x1 »). */
export function findNominalSize(nominal: string): NominalFilterSize | undefined {
  const normalized = nominal.trim().toLowerCase();
  return NOMINAL_FILTER_SIZES.find((size) => size.nominal === normalized);
}
