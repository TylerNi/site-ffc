import { defineRouting } from 'next-intl/routing';
import { locales } from '@ffc/i18n';

/**
 * L'admin n'est pas exposée sur les domaines publics : routage par
 * préfixe uniquement (`/fr/...`, `/en/...`), français par défaut.
 */
export const routing = defineRouting({
  locales,
  defaultLocale: 'fr',
  localePrefix: 'always',
});
