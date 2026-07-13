import { z } from 'zod';
import { mervValueSchema } from './merv';

/**
 * Pipeline de vision IA (tâche 17) — types et schémas PARTAGÉS entre l'API
 * (validation de la sortie des fournisseurs), l'admin (file de révision,
 * tâche 18) et le mobile (scanner, tâche 19).
 *
 * Deux modes d'analyse :
 *   - EQUIPMENT_LABEL (mode A) : photo de la plaque signalétique de la
 *     fournaise/échangeur → fabricant + numéro de modèle ;
 *   - FILTER_FRAME (mode B) : photo du filtre actuel → dimensions imprimées
 *     sur le cadre + cote MERV. C'est le mode LE PLUS FIABLE (le cadre
 *     annonce directement la taille cherchée) — à mettre de l'avant dans
 *     les parcours client (tâches 18/19).
 *
 * Ces valeurs ne sont PAS une enum Prisma : le mode vit dans l'enveloppe
 * JSONB `ai_identifications.extraction` (pas de colonne dédiée au schéma).
 */
export const AI_ANALYSIS_MODES = ['EQUIPMENT_LABEL', 'FILTER_FRAME'] as const;
export const aiAnalysisModeSchema = z.enum(AI_ANALYSIS_MODES);
export type AiAnalysisMode = z.infer<typeof aiAnalysisModeSchema>;

/** Confiance 0–1 (les fournisseurs sont bornés côté API avant validation). */
export const visionConfidenceSchema = z.number().min(0).max(1);

/** Champ textuel extrait : valeur lue (null si illisible/absente) + confiance. */
export const visionTextFieldSchema = z.object({
  value: z.string().min(1).nullable(),
  confidence: visionConfidenceSchema,
});
export type VisionTextField = z.infer<typeof visionTextFieldSchema>;

/**
 * Dimensions lues sur le cadre du filtre, en POUCES (LxHxP). Chaque
 * composante est nullable : un cadre partiellement lisible reste utile.
 */
export const visionDimensionsSchema = z.object({
  widthIn: z.number().positive().nullable(),
  heightIn: z.number().positive().nullable(),
  depthIn: z.number().positive().nullable(),
  confidence: visionConfidenceSchema,
});
export type VisionDimensions = z.infer<typeof visionDimensionsSchema>;

/** Cote MERV imprimée sur le cadre (1–20, null si absente). */
export const visionMervSchema = z.object({
  value: mervValueSchema.nullable(),
  confidence: visionConfidenceSchema,
});
export type VisionMerv = z.infer<typeof visionMervSchema>;

/**
 * Sortie STRUCTURÉE d'un fournisseur de vision — le contrat unique que les
 * implémentations Anthropic/OpenAI/log doivent produire (sortie structurée
 * native : output_config.format / response_format), validé par ce schéma.
 */
export const visionExtractionSchema = z.object({
  /** Fabricant de l'équipement (mode A) — ex. « Lennox ». */
  manufacturer: visionTextFieldSchema,
  /** Numéro de modèle (mode A) — ex. « G61MPV-36B-070 ». */
  modelNumber: visionTextFieldSchema,
  /** Dimensions nominales lues (mode B, ou visibles en mode A). */
  dimensions: visionDimensionsSchema,
  /** Cote MERV (mode B). */
  merv: visionMervSchema,
  /** Texte lisible brut de la photo (plaque ou cadre), pour la révision humaine. */
  readableText: z.string().nullable(),
  /**
   * Si la photo ressemble manifestement à L'AUTRE mode (ex. l'utilisateur a
   * photographié son filtre en mode plaque signalétique), le fournisseur le
   * signale ici — les écrans (tâches 18/19) proposent alors de basculer.
   */
  suggestedMode: aiAnalysisModeSchema.nullable(),
  /** Confiance globale 0–1 — comparée au seuil `ia.seuil_confiance`. */
  overallConfidence: visionConfidenceSchema,
  /** Remarques du modèle (photo floue, reflets, étiquette partielle…). */
  notes: z.string().nullable(),
});
export type VisionExtraction = z.infer<typeof visionExtractionSchema>;

/* ------------------------------------------------------------------ */
/* Enveloppe persistée dans ai_identifications.extraction (JSONB)      */
/* ------------------------------------------------------------------ */

/** Nature de la correspondance trouvée vers `equipment_models`. */
export const AI_MATCH_KINDS = ['exact', 'alias', 'fuzzy', 'none'] as const;
export const aiMatchKindSchema = z.enum(AI_MATCH_KINDS);
export type AiMatchKind = z.infer<typeof aiMatchKindSchema>;

/** Candidat de correspondance floue (pg_trgm), score décroissant. */
export const aiMatchCandidateSchema = z.object({
  equipmentModelId: z.uuid(),
  manufacturer: z.string(),
  modelNumber: z.string(),
  similarity: z.number().min(0).max(1),
});
export type AiMatchCandidate = z.infer<typeof aiMatchCandidateSchema>;

export const aiMatchResultSchema = z.object({
  kind: aiMatchKindSchema,
  /** Similarité pg_trgm du meilleur candidat (null pour exact/alias/none). */
  score: z.number().min(0).max(1).nullable(),
  candidates: z.array(aiMatchCandidateSchema),
});
export type AiMatchResult = z.infer<typeof aiMatchResultSchema>;

/** Variante de filtre proposée au client (mode B, ou compatibilités du modèle apparié). */
export const aiSuggestedVariantSchema = z.object({
  variantId: z.uuid(),
  sku: z.string(),
  nominalLabel: z.string(),
  merv: z.number().int().nullable(),
  packSize: z.number().int(),
  /** true si la cote MERV extraite correspond exactement à la variante. */
  mervMatches: z.boolean(),
});
export type AiSuggestedVariant = z.infer<typeof aiSuggestedVariantSchema>;

/**
 * Enveloppe complète du champ JSONB `extraction`. Après la purge (Loi 25,
 * 30 jours), l'enveloppe est REMPLACÉE par le marqueur minimal { mode,
 * purge } — vision/match/variants disparaissent avec la photo.
 */
export const aiExtractionEnvelopeSchema = z.object({
  mode: aiAnalysisModeSchema,
  vision: visionExtractionSchema.optional(),
  match: aiMatchResultSchema.optional(),
  variants: z.array(aiSuggestedVariantSchema).optional(),
  purge: z.object({ purgedAt: z.iso.datetime() }).optional(),
});
export type AiExtractionEnvelope = z.infer<typeof aiExtractionEnvelopeSchema>;

/**
 * Lecture TOLÉRANTE de l'enveloppe depuis la base : un JSONB inattendu
 * (donnée historique, main humaine) ne doit jamais faire planter un écran —
 * retourne null plutôt que de lever.
 */
export function parseAiExtractionEnvelope(raw: unknown): AiExtractionEnvelope | null {
  const result = aiExtractionEnvelopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}
