import { type Locale, LOCALES } from '@ffc/core';
import en from './locales/en.json';
import fr from './locales/fr.json';

export { LOCALES as locales, type Locale };

/** Forme des dictionnaires — le fichier anglais fait référence. */
export type Messages = typeof en;

/**
 * Dictionnaires partagés, consommés par next-intl (web, admin) et
 * i18next (mobile). L'annotation garantit que `fr` couvre toutes les
 * clés de `en`.
 */
export const messages: Record<Locale, Messages> = { fr, en };
