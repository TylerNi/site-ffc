import { Injectable } from '@nestjs/common';
import {
  type AiMatchCandidate,
  type AiMatchResult,
  type AiSuggestedVariant,
  canonicalDimensionLabel,
  dimensionEquivalents,
  type VisionDimensions,
} from '@ffc/core';
import { PrismaService } from '../../database';

/**
 * Correspondance extraction → catalogue (tâche 17).
 *
 * Mode A (plaque signalétique) : numéro de modèle NORMALISÉ (casse, tirets,
 * espaces) → correspondance exacte sur `equipment_models`, puis sur les
 * alias (GIN), puis FLOUE pg_trgm (similarity, meilleure candidate + score).
 * La table `equipment_models` + alias (enrichis en tâche 18) EST le cache de
 * correspondance : un numéro déjà résolu court-circuite le flou et ne
 * repasse jamais en file de révision.
 *
 * Mode B (cadre du filtre) : dimensions nominales → variantes du catalogue
 * via `parseDimensionInput`/`canonicalDimensionLabel` (@ffc/core) + MERV.
 */

/** Similarité pg_trgm minimale pour proposer une candidate floue. */
export const FUZZY_CANDIDATE_THRESHOLD = 0.45;

/**
 * Similarité à partir de laquelle la meilleure candidate floue est retenue
 * automatiquement comme correspondance (variation triviale de graphie).
 * En dessous, les candidates sont proposées mais la décision revient à la
 * file de révision humaine (tâche 18).
 */
export const FUZZY_ACCEPT_THRESHOLD = 0.85;

/** Normalisation d'un numéro de modèle : casse, tirets, espaces, ponctuation. */
export function normalizeModelNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Même normalisation pour les fabricants (« Lennox Industries » ⊇ « LENNOX »). */
export function normalizeManufacturer(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface EquipmentMatchOutcome {
  /** Modèle retenu automatiquement (exact, alias, ou flou ≥ seuil d'acceptation). */
  matchedEquipmentModelId: string | null;
  result: AiMatchResult;
}

interface EquipmentRow {
  id: string;
  manufacturer: string;
  model_number: string;
}

interface FuzzyRow extends EquipmentRow {
  sim: number;
}

@Injectable()
export class AiMatchingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mode A : fabricant + numéro de modèle extraits → equipment_models. */
  async matchEquipment(
    manufacturer: string | null,
    modelNumber: string | null,
  ): Promise<EquipmentMatchOutcome> {
    const none: AiMatchResult = { kind: 'none', score: null, candidates: [] };
    if (!modelNumber) return { matchedEquipmentModelId: null, result: none };

    const norm = normalizeModelNumber(modelNumber);
    if (!norm) return { matchedEquipmentModelId: null, result: none };

    // 1. Exacte sur le numéro de modèle normalisé.
    const exact = await this.prisma.$queryRaw<EquipmentRow[]>`
      SELECT id, manufacturer, model_number
      FROM equipment_models
      WHERE UPPER(REGEXP_REPLACE(model_number, '[^a-zA-Z0-9]', '', 'g')) = ${norm}`;
    const exactPick = pickUnambiguous(exact, manufacturer);
    if (exactPick) {
      return {
        matchedEquipmentModelId: exactPick.id,
        result: { kind: 'exact', score: null, candidates: [] },
      };
    }

    // 2. Exacte sur les alias (@> exploite l'index GIN ; unnest couvre les graphies).
    const alias = await this.prisma.$queryRaw<EquipmentRow[]>`
      SELECT id, manufacturer, model_number
      FROM equipment_models
      WHERE aliases @> ARRAY[${modelNumber}]::text[]
         OR EXISTS (
              SELECT 1 FROM unnest(aliases) AS a
              WHERE UPPER(REGEXP_REPLACE(a, '[^a-zA-Z0-9]', '', 'g')) = ${norm})`;
    const aliasPick = pickUnambiguous(alias, manufacturer);
    if (aliasPick) {
      return {
        matchedEquipmentModelId: aliasPick.id,
        result: { kind: 'alias', score: null, candidates: [] },
      };
    }

    // Exacte/alias ambiguë (même numéro chez plusieurs fabricants, fabricant
    // illisible) : on liste les candidates SANS trancher — révision humaine.
    const ambiguous = [...exact, ...alias];
    if (ambiguous.length > 0) {
      return {
        matchedEquipmentModelId: null,
        result: { kind: 'none', score: null, candidates: toCandidates(ambiguous, 1) },
      };
    }

    // 3. Floue pg_trgm sur le numéro et les alias (index trigram GIN).
    const fuzzy = await this.prisma.$queryRaw<FuzzyRow[]>`
      SELECT id, manufacturer, model_number,
             GREATEST(
               similarity(model_number, ${modelNumber}),
               COALESCE((SELECT MAX(similarity(a, ${modelNumber})) FROM unnest(aliases) AS a), 0)
             )::float8 AS sim
      FROM equipment_models
      WHERE model_number % ${modelNumber}
         OR EXISTS (SELECT 1 FROM unnest(aliases) AS a WHERE a % ${modelNumber})
      ORDER BY sim DESC
      LIMIT 5`;
    const candidates = fuzzy
      .filter((row) => row.sim >= FUZZY_CANDIDATE_THRESHOLD)
      .sort(
        (a, b) =>
          b.sim - a.sim ||
          manufacturerAffinity(b, manufacturer) - manufacturerAffinity(a, manufacturer),
      );
    if (candidates.length === 0) {
      return { matchedEquipmentModelId: null, result: none };
    }

    const best = candidates[0]!;
    const accepted = best.sim >= FUZZY_ACCEPT_THRESHOLD;
    return {
      matchedEquipmentModelId: accepted ? best.id : null,
      result: {
        kind: accepted ? 'fuzzy' : 'none',
        score: round3(best.sim),
        candidates: candidates.map((row) => ({
          equipmentModelId: row.id,
          manufacturer: row.manufacturer,
          modelNumber: row.model_number,
          similarity: round3(row.sim),
        })),
      },
    };
  }

  /**
   * Mode B : dimensions nominales lues sur le cadre (+ MERV) → variantes
   * actives du catalogue. Les équivalences nominal ↔ réel et l'orientation
   * interchangeable viennent du référentiel @ffc/core.
   */
  async matchVariantsByDimensions(
    dimensions: VisionDimensions,
    merv: number | null,
  ): Promise<AiSuggestedVariant[]> {
    const { widthIn, heightIn, depthIn } = dimensions;
    if (widthIn === null || heightIn === null) return [];

    const parsed = { width: widthIn, height: heightIn, depth: depthIn };
    const labels = new Set<string>();
    const resolved = dimensionEquivalents(canonicalDimensionLabel(parsed));
    for (const label of resolved?.labels ?? []) labels.add(label);
    if (labels.size === 0) {
      // Taille hors référentiel : libellé canonique tel quel, dans les deux orientations.
      labels.add(canonicalDimensionLabel(parsed));
      labels.add(canonicalDimensionLabel({ width: heightIn, height: widthIn, depth: depthIn }));
    }

    const variants = await this.prisma.productVariant.findMany({
      where: {
        nominalLabel: { in: [...labels] },
        isActive: true,
        product: { status: 'ACTIVE' },
      },
      select: { id: true, sku: true, nominalLabel: true, merv: true, packSize: true },
      orderBy: [{ merv: 'asc' }, { packSize: 'asc' }],
    });

    return rankVariants(variants, merv);
  }

  /**
   * Mode A : variantes compatibles du modèle apparié (table de
   * correspondance, entrées vérifiées d'abord).
   */
  async variantsForEquipmentModel(
    equipmentModelId: string,
    merv: number | null,
  ): Promise<AiSuggestedVariant[]> {
    const compatibilities = await this.prisma.modelFilterCompatibility.findMany({
      where: {
        equipmentModelId,
        variant: { isActive: true, product: { status: 'ACTIVE' } },
      },
      orderBy: [{ isVerified: 'desc' }, { createdAt: 'asc' }],
      select: {
        variant: {
          select: { id: true, sku: true, nominalLabel: true, merv: true, packSize: true },
        },
      },
    });
    return rankVariants(
      compatibilities.map((compat) => compat.variant),
      merv,
    );
  }
}

interface VariantRow {
  id: string;
  sku: string;
  nominalLabel: string;
  merv: number | null;
  packSize: number;
}

/** MERV exact d'abord, puis MERV croissant, puis format de boîte croissant. Limite : 10. */
function rankVariants(rows: VariantRow[], merv: number | null): AiSuggestedVariant[] {
  return rows
    .map((row) => ({
      variantId: row.id,
      sku: row.sku,
      nominalLabel: row.nominalLabel,
      merv: row.merv,
      packSize: row.packSize,
      mervMatches: merv !== null && row.merv === merv,
    }))
    .sort(
      (a, b) =>
        Number(b.mervMatches) - Number(a.mervMatches) ||
        (a.merv ?? 99) - (b.merv ?? 99) ||
        a.packSize - b.packSize,
    )
    .slice(0, 10);
}

/** Lignes exactes/alias ambiguës → candidates listées pour la révision humaine. */
function toCandidates(rows: EquipmentRow[], similarity: number): AiMatchCandidate[] {
  const seen = new Set<string>();
  const candidates: AiMatchCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({
      equipmentModelId: row.id,
      manufacturer: row.manufacturer,
      modelNumber: row.model_number,
      similarity,
    });
  }
  return candidates.slice(0, 5);
}

/** Une seule ligne, ou une seule dont le fabricant concorde → retenue ; sinon ambigu. */
function pickUnambiguous(rows: EquipmentRow[], manufacturer: string | null): EquipmentRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!;
  if (!manufacturer) return null;
  const matching = rows.filter((row) => manufacturerAffinity(row, manufacturer) > 0);
  return matching.length === 1 ? matching[0]! : null;
}

/** 1 si le fabricant extrait et celui de la ligne se contiennent (normalisés), 0 sinon. */
function manufacturerAffinity(row: EquipmentRow, manufacturer: string | null): number {
  if (!manufacturer) return 0;
  const a = normalizeManufacturer(manufacturer);
  const b = normalizeManufacturer(row.manufacturer);
  if (!a || !b) return 0;
  return a.includes(b) || b.includes(a) ? 1 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
