import { z } from 'zod';
import { type LocalizedText } from './locales';

/**
 * Cotes MERV (Minimum Efficiency Reporting Value) proposées au catalogue.
 */
export interface MervRating {
  readonly value: number;
  /** Plus petite taille de particule filtrée efficacement (µm). */
  readonly minParticleSizeMicrons: number;
  readonly description: LocalizedText;
}

/** Une cote MERV valide au sens de la norme ASHRAE 52.2 (1 à 20). */
export const mervValueSchema = z.number().int().min(1).max(20);

export const MERV_RATINGS: readonly MervRating[] = [
  {
    value: 8,
    minParticleSizeMicrons: 3,
    description: {
      fr: 'Poussière, pollen, charpie — protection de base du système CVC',
      en: 'Dust, pollen, lint — baseline HVAC protection',
    },
  },
  {
    value: 10,
    minParticleSizeMicrons: 1,
    description: {
      fr: 'Ajoute les squames d’animaux et la poussière fine',
      en: 'Adds pet dander and fine dust',
    },
  },
  {
    value: 11,
    minParticleSizeMicrons: 1,
    description: {
      fr: 'Recommandé pour les allergies légères et les animaux',
      en: 'Recommended for mild allergies and pets',
    },
  },
  {
    value: 13,
    minParticleSizeMicrons: 0.3,
    description: {
      fr: 'Fumée, bactéries, particules virales portées par gouttelettes',
      en: 'Smoke, bacteria, droplet-borne viral particles',
    },
  },
  {
    value: 14,
    minParticleSizeMicrons: 0.3,
    description: {
      fr: 'Filtration supérieure — usage quasi hospitalier',
      en: 'Superior filtration — near-hospital grade',
    },
  },
  {
    value: 16,
    minParticleSizeMicrons: 0.3,
    description: {
      fr: 'Filtration maximale pour systèmes résidentiels compatibles',
      en: 'Maximum filtration for compatible residential systems',
    },
  },
];

/** Retrouve une cote MERV offerte au catalogue. */
export function findMervRating(value: number): MervRating | undefined {
  return MERV_RATINGS.find((rating) => rating.value === value);
}
