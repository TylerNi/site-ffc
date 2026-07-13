/**
 * Tarifs publics des modèles de vision (USD par MILLION de jetons) — servent
 * au calcul du coût réel par photo du banc d'essai (`ai:bench`).
 *
 * ⚠️ Tarifs relevés le 2026-07-12 (platform.claude.com/docs/en/pricing et
 * openai.com/api/pricing) — à rafraîchir avant toute décision budgétaire.
 * Un modèle absent de la table donne un coût « n/d » dans le rapport, jamais
 * un chiffre inventé.
 */
export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const VISION_MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (Claude)
  'claude-fable-5': { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  'claude-opus-4-8': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  'claude-opus-4-7': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  'claude-opus-4-6': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  'claude-sonnet-5': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'claude-sonnet-4-6': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  // OpenAI (GPT)
  'gpt-5.1': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  'gpt-5': { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  'gpt-5-mini': { inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
  'gpt-5-nano': { inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.4 },
  'gpt-4.1': { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
  'gpt-4o': { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
};

/**
 * Tarif d'un modèle — correspondance exacte d'abord, puis par le préfixe le
 * plus long (les API renvoient parfois un identifiant daté, ex.
 * « gpt-5.1-2025-11-13 »). null si inconnu.
 */
export function pricingForModel(model: string): ModelPricing | null {
  const exact = VISION_MODEL_PRICING[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(VISION_MODEL_PRICING)) {
    if (model.startsWith(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? VISION_MODEL_PRICING[bestKey]! : null;
}

/** Coût d'un appel en USD (jetons × tarifs). null si tarif ou jetons inconnus. */
export function callCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | null,
): number | null {
  if (!usage) return null;
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputUsdPerMTok + usage.outputTokens * pricing.outputUsdPerMTok) /
    1_000_000
  );
}
