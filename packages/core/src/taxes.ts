import { z } from 'zod';
import { type LocalizedText } from './locales';

/**
 * Provinces et territoires canadiens + structure des taxes de vente.
 *
 * ⚠️ Les taux ci-dessous sont indicatifs : ils seront validés et finalisés
 * lors de l'implémentation du checkout (tâche 11). Ne pas utiliser pour
 * facturer avant validation.
 */

export const PROVINCE_CODES = [
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
] as const;

export const provinceCodeSchema = z.enum(PROVINCE_CODES);

export type ProvinceCode = z.infer<typeof provinceCodeSchema>;

/** Types de taxes de vente canadiennes. */
export const salesTaxKindSchema = z.enum(['GST', 'HST', 'PST', 'QST', 'RST']);

export type SalesTaxKind = z.infer<typeof salesTaxKindSchema>;

/** Taux exprimé en fraction décimale (0.05 = 5 %). */
export const salesTaxRateSchema = z.object({
  kind: salesTaxKindSchema,
  rate: z.number().min(0).max(1),
});

export type SalesTaxRate = z.infer<typeof salesTaxRateSchema>;

export interface ProvinceTaxProfile {
  readonly code: ProvinceCode;
  readonly name: LocalizedText;
  readonly taxes: readonly SalesTaxRate[];
}

const GST: SalesTaxRate = { kind: 'GST', rate: 0.05 };

export const PROVINCES: Record<ProvinceCode, ProvinceTaxProfile> = {
  AB: { code: 'AB', name: { fr: 'Alberta', en: 'Alberta' }, taxes: [GST] },
  BC: {
    code: 'BC',
    name: { fr: 'Colombie-Britannique', en: 'British Columbia' },
    taxes: [GST, { kind: 'PST', rate: 0.07 }],
  },
  MB: {
    code: 'MB',
    name: { fr: 'Manitoba', en: 'Manitoba' },
    taxes: [GST, { kind: 'RST', rate: 0.07 }],
  },
  NB: {
    code: 'NB',
    name: { fr: 'Nouveau-Brunswick', en: 'New Brunswick' },
    taxes: [{ kind: 'HST', rate: 0.15 }],
  },
  NL: {
    code: 'NL',
    name: { fr: 'Terre-Neuve-et-Labrador', en: 'Newfoundland and Labrador' },
    taxes: [{ kind: 'HST', rate: 0.15 }],
  },
  NS: {
    code: 'NS',
    name: { fr: 'Nouvelle-Écosse', en: 'Nova Scotia' },
    taxes: [{ kind: 'HST', rate: 0.14 }],
  },
  NT: {
    code: 'NT',
    name: { fr: 'Territoires du Nord-Ouest', en: 'Northwest Territories' },
    taxes: [GST],
  },
  NU: { code: 'NU', name: { fr: 'Nunavut', en: 'Nunavut' }, taxes: [GST] },
  ON: { code: 'ON', name: { fr: 'Ontario', en: 'Ontario' }, taxes: [{ kind: 'HST', rate: 0.13 }] },
  PE: {
    code: 'PE',
    name: { fr: 'Île-du-Prince-Édouard', en: 'Prince Edward Island' },
    taxes: [{ kind: 'HST', rate: 0.15 }],
  },
  QC: {
    code: 'QC',
    name: { fr: 'Québec', en: 'Quebec' },
    taxes: [GST, { kind: 'QST', rate: 0.09975 }],
  },
  SK: {
    code: 'SK',
    name: { fr: 'Saskatchewan', en: 'Saskatchewan' },
    taxes: [GST, { kind: 'PST', rate: 0.06 }],
  },
  YT: { code: 'YT', name: { fr: 'Yukon', en: 'Yukon' }, taxes: [GST] },
};

/** Taux combiné pour une province (fraction décimale). */
export function combinedTaxRate(code: ProvinceCode): number {
  return PROVINCES[code].taxes.reduce((total, tax) => total + tax.rate, 0);
}
