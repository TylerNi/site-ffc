import { type Locale } from '@ffc/i18n';
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/**
 * URL canoniques et hreflang de la vitrine.
 *
 * En production, chaque locale vit sur son propre domaine (fr →
 * filtrationmontreal.com, en → furnacefilterscanada.com) : les chemins n'y
 * portent JAMAIS de préfixe de locale. En local (une seule origine), le
 * français est préfixé `/fr` et l'anglais (locale par défaut) reste nu —
 * exactement le comportement du middleware next-intl.
 */

/** Href accepté par la navigation typée (clé de pathnames + params). */
export type LocalizedHref = Parameters<typeof getPathname>[0]['href'];

/** Nom public du site dans chaque locale (title, JSON-LD, OpenGraph). */
export const SITE_NAMES: Record<Locale, string> = {
  fr: 'Filtration Montréal',
  en: 'Furnace Filters Canada',
};

const FALLBACK_ORIGIN = 'http://localhost:3000';

/** Origine (scheme + hôte) servant une locale. Sans env : localhost (dev). */
export function siteOrigin(locale: Locale): string {
  const configured =
    locale === 'fr' ? process.env.NEXT_PUBLIC_SITE_URL_FR : process.env.NEXT_PUBLIC_SITE_URL_EN;
  return (configured ?? FALLBACK_ORIGIN).replace(/\/+$/, '');
}

/** true si les deux locales partagent la même origine (mode préfixe, dev). */
export function sharedHost(): boolean {
  return siteOrigin('fr') === siteOrigin('en');
}

export function otherLocale(locale: Locale): Locale {
  return locale === 'fr' ? 'en' : 'fr';
}

/**
 * Chemin localisé d'un href interne, avec la règle de préfixe ci-dessus.
 * Normalise la sortie de `getPathname` (qui préfixe les locales non défaut)
 * pour rester déterministe dans les deux modes.
 */
export function localizedPath(locale: Locale, href: LocalizedHref): string {
  const raw = getPathname({ locale, href });
  const prefix = `/${locale}`;
  const bare = raw === prefix ? '/' : raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length) : raw;

  if (locale === routing.defaultLocale || !sharedHost()) return bare;
  return bare === '/' ? prefix : `${prefix}${bare}`;
}

/** URL absolue d'un href interne pour une locale (canonical, hreflang, JSON-LD). */
export function absoluteUrl(locale: Locale, href: LocalizedHref): string {
  const path = localizedPath(locale, href);
  return `${siteOrigin(locale)}${path === '/' ? '/' : path}`;
}

/**
 * Locale servie par un hôte HTTP (robots.txt et sitemap.xml par domaine).
 * `'shared'` : les deux locales sur la même origine (dev, préfixe `/fr`).
 * `null` : hôte inconnu (staging, IP) — ne rien laisser indexer.
 */
export function localeForHost(host: string): Locale | 'shared' | null {
  const normalized = host.toLowerCase();
  const frHost = new URL(siteOrigin('fr')).host.toLowerCase();
  const enHost = new URL(siteOrigin('en')).host.toLowerCase();
  if (frHost === enHost) return normalized === frHost ? 'shared' : null;
  if (normalized === frHost) return 'fr';
  if (normalized === enHost) return 'en';
  return null;
}
