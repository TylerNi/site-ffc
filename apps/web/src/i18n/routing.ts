import { defineRouting } from 'next-intl/routing';
import { locales } from '@ffc/i18n';

/**
 * Deux modes de routage, pilotés par l'environnement :
 *
 * - **Production** (`NEXT_PUBLIC_SITE_URL_FR/EN` définies AU BUILD) : un
 *   domaine par locale (filtrationmontreal.com → fr, furnacefilterscanada.com
 *   → en), aucune URL préfixée — le domaine porte la langue.
 * - **Développement** (aucune env) : une seule origine, français préfixé
 *   `/fr`, anglais (locale par défaut) sans préfixe.
 *
 * La config `domains` n'existe qu'en production : next-intl génère alors des
 * liens sans préfixe (corrects sur les domaines dédiés), et des liens
 * préfixés en local — alignés avec `src/lib/site.ts` (canonical, hreflang,
 * sitemaps) qui lit les mêmes variables.
 *
 * Les `pathnames` localisent les segments d'URL (slugs de contenu localisés
 * par l'API) : `/produits/...` ↔ `/products/...`. Le SEO exige des URL
 * propres dans chaque langue.
 */

const FR_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL_FR;
const EN_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL_EN;
const dedicatedDomains = Boolean(FR_ORIGIN && EN_ORIGIN && FR_ORIGIN !== EN_ORIGIN);

export const routing = defineRouting({
  locales,
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  // Les liens hreflang sont gérés par les métadonnées des pages (URL
  // absolues inter-domaines) — pas d'en-têtes Link automatiques.
  alternateLinks: false,
  domains: dedicatedDomains
    ? [
        { domain: new URL(FR_ORIGIN!).host, defaultLocale: 'fr', locales: ['fr'] },
        { domain: new URL(EN_ORIGIN!).host, defaultLocale: 'en', locales: ['en'] },
      ]
    : undefined,
  pathnames: {
    '/': '/',
    '/products/[slug]': { en: '/products/[slug]', fr: '/produits/[slug]' },
    '/categories/[slug]': '/categories/[slug]',
    '/sizes': { en: '/sizes', fr: '/tailles' },
    '/sizes/[label]': { en: '/sizes/[label]', fr: '/tailles/[label]' },
    '/search': { en: '/search', fr: '/recherche' },
    '/cart': { en: '/cart', fr: '/panier' },
    '/checkout': { en: '/checkout', fr: '/caisse' },
    '/checkout/success': { en: '/checkout/success', fr: '/caisse/confirmation' },
  },
});

/** Chemin interne (clé de `pathnames`) — les pages raisonnent avec ça. */
export type AppPathname = keyof typeof routing.pathnames;
