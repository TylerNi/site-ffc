import { type AiAnalysisMode, type VisionExtraction } from '@ffc/core';

/**
 * Interface COMMUNE des fournisseurs de vision (tâche 17) — même philosophie
 * que `TaxCalculator` (tâche 11) et `CarrierTracker` (tâche 14) : toutes les
 * particularités (SDK, format de sortie structurée, tarifs, erreurs maison)
 * restent enfermées dans l'implémentation ; le pipeline ne voit que ces
 * types. Changer de fournisseur = changer `AI_VISION_DRIVER`.
 */

export interface VisionInput {
  /** Image ASSAINIE (ré-encodée sans EXIF par `image-content.ts`). */
  image: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  mode: AiAnalysisMode;
}

export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface VisionAnalysis {
  /** Sortie structurée VALIDÉE par `visionExtractionSchema` (@ffc/core). */
  extraction: VisionExtraction;
  /** Nom du fournisseur (« anthropic », « openai », « log ») — persisté. */
  provider: string;
  /** Identifiant exact du modèle utilisé — persisté (banc d'essai). */
  model: string;
  latencyMs: number;
  /** Jetons consommés (coût réel au banc d'essai) ; null si non exposés. */
  usage: VisionUsage | null;
}

export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  /** false = clé API absente : les endpoints IA répondent 503 proprement. */
  isConfigured(): boolean;
  analyze(input: VisionInput): Promise<VisionAnalysis>;
}

/** Jeton d'injection du fournisseur actif (choisi par AI_VISION_DRIVER). */
export const VISION_PROVIDER = Symbol('VISION_PROVIDER');

/**
 * Erreur d'analyse. `retryable` sépare le transitoire (429, 5xx, réseau —
 * BullMQ retente) du définitif (clé refusée, image rejetée, sortie
 * inexploitable — l'identification passe en FAILED sans rappel).
 */
export class VisionProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VisionProviderError';
  }
}
