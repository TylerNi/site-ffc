import { z } from 'zod';

/**
 * Locales supportées par la plateforme.
 * filtrationmontreal.com → fr · furnacefilterscanada.com → en
 */
export const LOCALES = ['fr', 'en'] as const;

export const localeSchema = z.enum(LOCALES);

export type Locale = z.infer<typeof localeSchema>;

/** Texte localisé (les deux langues sont toujours requises). */
export const localizedTextSchema = z.object({
  fr: z.string(),
  en: z.string(),
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;
