import { defineRouting } from 'next-intl/routing';
import { locales } from '@ffc/i18n';

/**
 * La locale est déterminée par le domaine en production
 * (filtrationmontreal.com → fr, furnacefilterscanada.com → en).
 * Sur un hôte inconnu (localhost en développement), repli par préfixe :
 * `/fr/...` et `/...` (anglais, locale par défaut, sans préfixe).
 */
export const routing = defineRouting({
  locales,
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  domains: [
    { domain: 'filtrationmontreal.com', defaultLocale: 'fr', locales: ['fr'] },
    { domain: 'furnacefilterscanada.com', defaultLocale: 'en', locales: ['en'] },
  ],
});
