import { z } from 'zod';
import { PROVINCE_CODES, shippingCountrySchema } from './taxes';

/**
 * Adresses de livraison/facturation : formats postaux CA/US (tâche 11).
 *
 * La validation vit ici (et non dans l'API) pour être partagée telle
 * quelle par l'API NestJS, la vitrine web et l'app mobile — un seul
 * ensemble de règles, pas de dérive entre plateformes.
 */

/**
 * Code postal canadien « A1A 1A1 » :
 *   - jamais D, F, I, O, Q ni U (confusion visuelle) ;
 *   - W et Z interdits en PREMIÈRE lettre seulement.
 */
const CA_FIRST_LETTER = '[ABCEGHJ-NPRSTVXY]';
const CA_LETTER = '[ABCEGHJ-NPRSTV-Z]';
export const CA_POSTAL_CODE_REGEX = new RegExp(
  `^${CA_FIRST_LETTER}\\d${CA_LETTER}[ -]?\\d${CA_LETTER}\\d$`,
  'i',
);

/** ZIP américain « 12345 » ou « 12345-6789 ». */
export const US_ZIP_REGEX = /^\d{5}(?:-\d{4})?$/;

export function isValidCanadianPostalCode(value: string): boolean {
  return CA_POSTAL_CODE_REGEX.test(value.trim());
}

export function isValidUsZip(value: string): boolean {
  return US_ZIP_REGEX.test(value.trim());
}

/** « h2l2g8 » → « H2L 2G8 » (forme canonique stockée et affichée). */
export function normalizeCanadianPostalCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[ -]/g, '');
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

/** États américains (50) + District de Columbia. */
export const US_STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export const usStateCodeSchema = z.enum(US_STATE_CODES);
export type UsStateCode = z.infer<typeof usStateCodeSchema>;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/**
 * Adresse de checkout, validée côté serveur À CHAQUE usage (aucune valeur
 * du client n'est crue). `province` porte le code de province (CA) ou
 * d'état (US) ; `postalCode` ressort NORMALISÉ (« H2L 2G8 », « 14201 »).
 */
export const checkoutAddressSchema = z
  .object({
    firstName: trimmed(100),
    lastName: trimmed(100),
    company: z.string().trim().max(150).optional(),
    line1: trimmed(200),
    line2: z.string().trim().max(200).optional(),
    city: trimmed(120),
    province: z.string().trim().toUpperCase(),
    postalCode: trimmed(12),
    country: shippingCountrySchema,
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ().-]{7,20}$/, 'Numéro de téléphone invalide')
      .optional(),
  })
  .superRefine((address, ctx) => {
    if (address.country === 'CA') {
      if (!PROVINCE_CODES.includes(address.province as (typeof PROVINCE_CODES)[number])) {
        ctx.addIssue({
          code: 'custom',
          path: ['province'],
          message: 'Province canadienne invalide',
        });
      }
      if (!isValidCanadianPostalCode(address.postalCode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['postalCode'],
          message: 'Code postal canadien invalide (format A1A 1A1)',
        });
      }
    } else {
      if (!usStateCodeSchema.safeParse(address.province).success) {
        ctx.addIssue({ code: 'custom', path: ['province'], message: 'État américain invalide' });
      }
      if (!isValidUsZip(address.postalCode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['postalCode'],
          message: 'Code ZIP américain invalide (12345 ou 12345-6789)',
        });
      }
    }
  })
  .transform((address) => ({
    ...address,
    postalCode:
      address.country === 'CA'
        ? normalizeCanadianPostalCode(address.postalCode)
        : address.postalCode.trim(),
  }));

export type CheckoutAddress = z.infer<typeof checkoutAddressSchema>;
