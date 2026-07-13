import { visionExtractionSchema, type VisionExtraction } from '@ffc/core';

/**
 * Schéma JSON de la sortie structurée, envoyé aux DEUX fournisseurs
 * (Anthropic `output_config.format`, OpenAI `response_format`) — miroir du
 * schéma zod `visionExtractionSchema` de @ffc/core, qui reste l'unique
 * source de vérité à la validation.
 *
 * Contraintes des sorties structurées : `additionalProperties: false` sur
 * chaque objet, tous les champs `required`, et AUCUNE borne numérique
 * (minimum/maximum non supportés) — les bornes vivent dans les descriptions
 * et sont imposées par `parseVisionExtraction` (clamp + zod) au retour.
 */
export const VISION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'manufacturer',
    'modelNumber',
    'dimensions',
    'merv',
    'readableText',
    'suggestedMode',
    'overallConfidence',
    'notes',
  ],
  properties: {
    manufacturer: textField('Fabricant de l’équipement CVC (ex. « Lennox », « Carrier »).'),
    modelNumber: textField(
      'Numéro de modèle EXACT tel qu’imprimé (ex. « G61MPV-36B-070 ») — pas le numéro de série.',
    ),
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['widthIn', 'heightIn', 'depthIn', 'confidence'],
      description: 'Dimensions nominales du filtre en POUCES (Largeur x Hauteur x Profondeur).',
      properties: {
        widthIn: { type: ['number', 'null'], description: 'Largeur en pouces, null si illisible.' },
        heightIn: {
          type: ['number', 'null'],
          description: 'Hauteur en pouces, null si illisible.',
        },
        depthIn: {
          type: ['number', 'null'],
          description: 'Profondeur (épaisseur) en pouces, null si illisible.',
        },
        confidence: { type: 'number', description: 'Confiance 0 à 1.' },
      },
    },
    merv: {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'confidence'],
      description: 'Cote MERV imprimée sur le cadre (1 à 20).',
      properties: {
        value: { type: ['integer', 'null'], description: 'Cote MERV 1–20, null si absente.' },
        confidence: { type: 'number', description: 'Confiance 0 à 1.' },
      },
    },
    readableText: {
      type: ['string', 'null'],
      description: 'Transcription brute du texte lisible sur la photo (pour révision humaine).',
    },
    suggestedMode: {
      type: ['string', 'null'],
      enum: ['EQUIPMENT_LABEL', 'FILTER_FRAME', null],
      description:
        'Si la photo correspond manifestement à l’AUTRE mode d’analyse, l’indiquer ici ; sinon null.',
    },
    overallConfidence: {
      type: 'number',
      description: 'Confiance globale 0 à 1 sur l’ensemble de l’extraction.',
    },
    notes: {
      type: ['string', 'null'],
      description: 'Remarques utiles (photo floue, reflets, étiquette partielle…), sinon null.',
    },
  },
} as const;

function textField(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence'],
    description,
    properties: {
      value: { type: ['string', 'null'], description: 'Valeur lue, null si illisible ou absente.' },
      confidence: { type: 'number', description: 'Confiance 0 à 1.' },
    },
  } as const;
}

const clamp01 = (value: unknown): unknown =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : value;

/**
 * Valide la sortie brute d'un fournisseur contre le schéma zod partagé.
 * Les confiances sont bornées à [0, 1] AVANT validation (un modèle qui
 * répond 1.05 ne doit pas faire échouer toute l'analyse) ; toute autre
 * divergence de forme est une vraie erreur de fournisseur.
 */
export function parseVisionExtraction(raw: unknown): VisionExtraction {
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    candidate.overallConfidence = clamp01(candidate.overallConfidence);
    for (const key of ['manufacturer', 'modelNumber', 'dimensions', 'merv']) {
      const field = candidate[key];
      if (field && typeof field === 'object') {
        (field as Record<string, unknown>).confidence = clamp01(
          (field as Record<string, unknown>).confidence,
        );
      }
    }
    // Une chaîne vide « lue » n'apporte rien : normalisée en null.
    for (const key of ['manufacturer', 'modelNumber']) {
      const field = candidate[key] as Record<string, unknown> | undefined;
      if (field && typeof field.value === 'string' && field.value.trim() === '') {
        field.value = null;
      }
    }
  }
  return visionExtractionSchema.parse(raw);
}
