import { type Locale } from '@ffc/i18n';

/** Formatage monétaire canadien : « 13,99 $ » (fr-CA) / « $13.99 » (en-CA). */

const INTL_LOCALES: Record<Locale, string> = { fr: 'fr-CA', en: 'en-CA' };

export function formatCents(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale], {
    style: 'currency',
    currency,
    // Les prix du catalogue tombent juste — garder les décimales (normes
    // d'affichage commerce), Intl gère la position du symbole par locale.
  }).format(cents / 100);
}

/** Fourchette « à partir de … jusqu'à … » compacte; identique si from === to. */
export function formatCentsRange(
  from: number,
  to: number,
  currency: string,
  locale: Locale,
): string {
  if (from === to) return formatCents(from, currency, locale);
  return `${formatCents(from, currency, locale)} – ${formatCents(to, currency, locale)}`;
}

/** Prix décimal pour JSON-LD (« 13.99 » — toujours un point, deux décimales). */
export function jsonLdPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Dimension en pouces lisible : 15.75 → « 15,75 » (fr) / « 15.75 » (en). */
export function formatInches(value: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale], { maximumFractionDigits: 2 }).format(value);
}

/** « 15,75 × 24,75 × 0,75 po » / « 15.75 × 24.75 × 0.75 in ». */
export function formatDimensions(
  dims: { width: number; height: number; depth: number },
  locale: Locale,
): string {
  const unit = locale === 'fr' ? 'po' : 'in';
  return `${formatInches(dims.width, locale)} × ${formatInches(dims.height, locale)} × ${formatInches(dims.depth, locale)} ${unit}`;
}

/** Liste « 8, 11 et 13 » / « 8, 11 and 13 » (cotes MERV dans les textes SEO). */
export function formatList(values: Array<string | number>, locale: Locale): string {
  return new Intl.ListFormat(INTL_LOCALES[locale], { style: 'long', type: 'conjunction' }).format(
    values.map(String),
  );
}
