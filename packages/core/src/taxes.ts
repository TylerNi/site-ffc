import { z } from 'zod';
import { type LocalizedText } from './locales';

/**
 * Provinces et territoires canadiens + taxes de vente + moteur de calcul.
 *
 * Taux VALIDÉS à la tâche 11 (checkout), en vigueur au 2026-07 :
 *   - TPS fédérale 5 % (AB, NT, NU, YT seuls) ;
 *   - TVH : ON 13 % ; NB, NL, PE 15 % ; **NS 14 % depuis le 2025-04-01**
 *     (le brief de la tâche 11 mentionnait encore 15 %, antérieur à la baisse) ;
 *   - QC : TPS 5 % + TVQ 9,975 % (la TVQ se calcule sur le prix AVANT TPS
 *     depuis 2013 — chaque taxe s'applique donc indépendamment à la base) ;
 *   - BC : TPS + TVP 7 % ; SK : TPS + TVP 6 % ; MB : TPS + TVD 7 %.
 *
 * Tout changement de taux se fait ICI (source de vérité unique) ; les
 * commandes déjà passées conservent leurs montants figés dans order_items.
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

/* ------------------------------------------------------------------ */
/* Moteur de calcul (tâche 11) — interface TaxCalculator               */
/* ------------------------------------------------------------------ */

/** Pays de livraison pris en charge par la boutique. */
export const SHIPPING_COUNTRIES = ['CA', 'US'] as const;
export const shippingCountrySchema = z.enum(SHIPPING_COUNTRIES);
export type ShippingCountry = z.infer<typeof shippingCountrySchema>;

/** Ligne taxable : montant en cents APRÈS remise (base d'imposition). */
export interface TaxableLine {
  /** Identifiant opaque restitué tel quel dans le résultat. */
  readonly id: string;
  readonly amountCents: number;
}

export interface TaxDestination {
  readonly country: ShippingCountry;
  /** Code de province (CA) ou d'état (US). */
  readonly region: string;
}

export interface TaxCalculationInput {
  readonly destination: TaxDestination;
  readonly lines: readonly TaxableLine[];
  /** Frais de livraison (taxables au Canada, ligne à part). */
  readonly shippingCents: number;
}

export interface TaxAmount {
  readonly kind: SalesTaxKind;
  readonly cents: number;
}

export interface LineTaxResult {
  readonly id: string;
  /** Total des taxes de la ligne, toutes composantes confondues. */
  readonly taxCents: number;
  readonly breakdown: readonly TaxAmount[];
}

/**
 * Ventilation par type aligné sur les colonnes d'`orders` :
 * `pstCents` regroupe TVP (BC/SK) et TVD (MB), comme `tax_pst_cents`.
 */
export interface TaxTotals {
  readonly gstCents: number;
  readonly qstCents: number;
  readonly hstCents: number;
  readonly pstCents: number;
}

export interface TaxCalculationResult {
  readonly lines: readonly LineTaxResult[];
  readonly shipping: LineTaxResult;
  readonly totals: TaxTotals;
  readonly totalTaxCents: number;
}

/**
 * Interface de calcul des taxes de vente — point de greffe prévu pour
 * Stripe Tax (point ouvert n° 6 du plan projet) : brancher un autre
 * fournisseur = fournir une autre implémentation, rien d'autre ne change.
 */
export interface TaxCalculator {
  calculate(input: TaxCalculationInput): TaxCalculationResult;
}

/** Colonne de commande associée à chaque composante de taxe. */
const KIND_TO_TOTAL: Record<SalesTaxKind, keyof TaxTotals> = {
  GST: 'gstCents',
  QST: 'qstCents',
  HST: 'hstCents',
  PST: 'pstCents',
  RST: 'pstCents',
};

/**
 * Arrondi au cent « half-up » exact, en arithmétique ENTIÈRE (jamais de
 * flottant : 0,285 × 5 % doit donner le même cent partout). Le taux est
 * exprimé en parties par million (TVQ 9,975 % → 99 750 ppm).
 */
export function taxCentsFor(amountCents: number, ratePpm: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`Montant taxable invalide : ${amountCents}`);
  }
  return Number((BigInt(amountCents) * BigInt(ratePpm) + 500_000n) / 1_000_000n);
}

/** Taux en parties par million — exact pour tous nos taux (≤ 5 décimales). */
export function ratePpm(rate: number): number {
  return Math.round(rate * 1_000_000);
}

const NO_TAXES: readonly SalesTaxRate[] = [];

function taxesFor(destination: TaxDestination): readonly SalesTaxRate[] {
  if (destination.country === 'US') return NO_TAXES;
  const parsed = provinceCodeSchema.safeParse(destination.region);
  if (!parsed.success) {
    throw new RangeError(`Province de livraison inconnue : « ${destination.region} »`);
  }
  return PROVINCES[parsed.data].taxes;
}

function taxLine(id: string, amountCents: number, taxes: readonly SalesTaxRate[]): LineTaxResult {
  const breakdown = taxes.map((tax) => ({
    kind: tax.kind,
    cents: taxCentsFor(amountCents, ratePpm(tax.rate)),
  }));
  return {
    id,
    taxCents: breakdown.reduce((sum, part) => sum + part.cents, 0),
    breakdown,
  };
}

/**
 * Calculateur v1 : tables maison ci-dessus.
 *
 * Règles d'arrondi (exigence « arrondis au cent corrects ») :
 *   - chaque composante de taxe est calculée et arrondie PAR LIGNE
 *     (half-up) sur la base après remise — c'est la ventilation que
 *     reçoivent `order_items.tax_cents` et les rapports de taxes ;
 *   - les totaux de commande sont la SOMME des lignes (jamais un recalcul
 *     global qui pourrait diverger d'un cent).
 *   - livraison : ligne taxable à part entière (CA) ; É.-U. : aucune taxe
 *     (les frais fixes configurés couvrent la logistique transfrontalière).
 */
export class CanadianTaxCalculator implements TaxCalculator {
  calculate(input: TaxCalculationInput): TaxCalculationResult {
    const taxes = taxesFor(input.destination);

    const lines = input.lines.map((line) => taxLine(line.id, line.amountCents, taxes));
    const shipping = taxLine('shipping', input.shippingCents, taxes);

    const totals = { gstCents: 0, qstCents: 0, hstCents: 0, pstCents: 0 };
    for (const result of [...lines, shipping]) {
      for (const part of result.breakdown) {
        totals[KIND_TO_TOTAL[part.kind]] += part.cents;
      }
    }

    return {
      lines,
      shipping,
      totals,
      totalTaxCents: totals.gstCents + totals.qstCents + totals.hstCents + totals.pstCents,
    };
  }
}
