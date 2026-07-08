import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  CanadianTaxCalculator,
  checkoutAddressSchema,
  isValidCanadianPostalCode,
  isValidUsZip,
  normalizeCanadianPostalCode,
  PROVINCE_CODES,
  PROVINCES,
  taxCentsFor,
  type TaxCalculationInput,
} from './index';

const calculator = new CanadianTaxCalculator();

function calculate(region: string, amountCents: number, shippingCents = 0) {
  const input: TaxCalculationInput = {
    destination: { country: region.length === 2 && region !== 'US' ? 'CA' : 'US', region },
    lines: [{ id: 'l1', amountCents }],
    shippingCents,
  };
  if (region === 'US-NY') {
    return calculator.calculate({ ...input, destination: { country: 'US', region: 'NY' } });
  }
  return calculator.calculate(input);
}

describe('CanadianTaxCalculator — taux par province (critères de la tâche 11)', () => {
  it('QC : TPS 5 % + TVQ 9,975 % sur 100,00 $ → 5,00 + 9,98', () => {
    const result = calculate('QC', 10_000);
    expect(result.totals.gstCents).toBe(500);
    expect(result.totals.qstCents).toBe(998); // 997,5 arrondi half-up
    expect(result.totals.hstCents).toBe(0);
    expect(result.totals.pstCents).toBe(0);
    expect(result.totalTaxCents).toBe(1498);
  });

  it('ON : TVH 13 % sur 100,00 $ → 13,00', () => {
    const result = calculate('ON', 10_000);
    expect(result.totals).toEqual({ gstCents: 0, qstCents: 0, hstCents: 1300, pstCents: 0 });
  });

  it('NS : TVH 14 % (taux en vigueur depuis le 2025-04-01) sur 100,00 $ → 14,00', () => {
    const result = calculate('NS', 10_000);
    expect(result.totals.hstCents).toBe(1400);
    expect(result.totalTaxCents).toBe(1400);
  });

  it('AB : TPS 5 % seule sur 100,00 $ → 5,00', () => {
    const result = calculate('AB', 10_000);
    expect(result.totals).toEqual({ gstCents: 500, qstCents: 0, hstCents: 0, pstCents: 0 });
  });

  it('BC : TPS 5 % + TVP 7 % sur 100,00 $ → 5,00 + 7,00', () => {
    const result = calculate('BC', 10_000);
    expect(result.totals).toEqual({ gstCents: 500, qstCents: 0, hstCents: 0, pstCents: 700 });
  });

  it('MB : la TVD est ventilée dans pstCents', () => {
    const result = calculate('MB', 10_000);
    expect(result.totals.pstCents).toBe(700);
    expect(result.totals.gstCents).toBe(500);
  });

  it('É.-U. : aucune taxe, quel que soit le montant', () => {
    const result = calculator.calculate({
      destination: { country: 'US', region: 'NY' },
      lines: [{ id: 'l1', amountCents: 123_456 }],
      shippingCents: 2500,
    });
    expect(result.totalTaxCents).toBe(0);
    expect(result.totals).toEqual({ gstCents: 0, qstCents: 0, hstCents: 0, pstCents: 0 });
  });

  it('couvre les 13 provinces/territoires sans lancer', () => {
    for (const code of PROVINCE_CODES) {
      const result = calculate(code, 4_999);
      const combined = PROVINCES[code].taxes.reduce((sum, tax) => sum + tax.rate, 0);
      // Cohérence d'ordre de grandeur : total ≈ montant × taux combiné (± 1 cent/composante).
      expect(Math.abs(result.totalTaxCents - 4_999 * combined)).toBeLessThanOrEqual(
        PROVINCES[code].taxes.length,
      );
    }
  });

  it('province inconnue → erreur franche', () => {
    expect(() =>
      calculator.calculate({
        destination: { country: 'CA', region: 'XX' },
        lines: [{ id: 'l1', amountCents: 100 }],
        shippingCents: 0,
      }),
    ).toThrow(/Province de livraison inconnue/);
  });
});

describe('CanadianTaxCalculator — arrondis au cent et ventilation par ligne', () => {
  it('arrondit half-up PAR LIGNE et PAR COMPOSANTE (jamais de recalcul global)', () => {
    // 3 lignes de 0,05 $ au QC : TVQ par ligne = 0,0049875 $ → 0 cent chacune.
    // Un calcul global (0,15 $ × 9,975 % = 1,5 cent → 2) divergerait.
    const result = calculator.calculate({
      destination: { country: 'CA', region: 'QC' },
      lines: [
        { id: 'a', amountCents: 5 },
        { id: 'b', amountCents: 5 },
        { id: 'c', amountCents: 5 },
      ],
      shippingCents: 0,
    });
    expect(result.lines.map((line) => line.taxCents)).toEqual([0, 0, 0]);
    expect(result.totalTaxCents).toBe(0);
  });

  it('le total est TOUJOURS la somme des lignes (propriété, montants irréguliers)', () => {
    const amounts = [1, 33, 99, 101, 999, 1234, 9_999, 123_457];
    for (const code of ['QC', 'ON', 'BC', 'NS'] as const) {
      const result = calculator.calculate({
        destination: { country: 'CA', region: code },
        lines: amounts.map((amountCents, index) => ({ id: String(index), amountCents })),
        shippingCents: 777,
      });
      const linesSum = result.lines.reduce((sum, line) => sum + line.taxCents, 0);
      expect(linesSum + result.shipping.taxCents).toBe(result.totalTaxCents);
    }
  });

  it('cas limite half-up : 0,10 $ à 5 % → 0,005 $ arrondi à 1 cent', () => {
    expect(taxCentsFor(10, 50_000)).toBe(1);
    expect(taxCentsFor(9, 50_000)).toBe(0); // 0,0045 $ → 0
  });

  it('exactitude entière : pas de dérive flottante sur les gros montants', () => {
    // 19 999 999,99 $ à 9,975 % = 1 994 999,999 $ → 199 500 000 cents exactement.
    expect(taxCentsFor(1_999_999_999, 99_750)).toBe(199_500_000);
  });

  it('la livraison est une ligne taxable à part (CA)', () => {
    const result = calculate('ON', 10_000, 999);
    expect(result.shipping.taxCents).toBe(130); // 9,99 × 13 % = 1,2987 → 1,30
    expect(result.totals.hstCents).toBe(1430);
  });

  it('montant taxable négatif ou non entier → erreur', () => {
    expect(() => taxCentsFor(-1, 50_000)).toThrow(RangeError);
    expect(() => taxCentsFor(1.5, 50_000)).toThrow(RangeError);
  });
});

describe('allocateProportionally — répartition de remise au cent près', () => {
  it('répartit exactement le total (plus fort reste)', () => {
    // 10,00 $ de remise sur des lignes 19,99 / 9,99 / 5,00 : parts entières
    // 571/285/142, puis les 2 cents restants aux plus forts restes (l3 : 0,94 ;
    // l2 : 0,59).
    const shares = allocateProportionally(1_000, [1_999, 999, 500]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000);
    expect(shares).toEqual([571, 286, 143]);
  });

  it('total nul ou poids nuls → zéros', () => {
    expect(allocateProportionally(0, [100, 200])).toEqual([0, 0]);
    expect(allocateProportionally(500, [0, 0])).toEqual([0, 0]);
  });

  it("ne dépasse jamais le poids d'une ligne (pas de sous-total négatif)", () => {
    const shares = allocateProportionally(300, [100, 200]);
    expect(shares).toEqual([100, 200]);
  });

  it('total supérieur aux poids → erreur (le rabais est plafonné en amont)', () => {
    expect(() => allocateProportionally(301, [100, 200])).toThrow(RangeError);
  });

  it('propriété : somme exacte et parts bornées pour des cas variés', () => {
    const cases: Array<[number, number[]]> = [
      [1, [1_999, 999, 500]],
      [999, [999]],
      [7, [3, 3, 3]],
      [1_234, [4_999, 1, 1, 4_999]],
    ];
    for (const [total, weights] of cases) {
      const shares = allocateProportionally(total, weights);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      shares.forEach((share, index) => {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(weights[index]!);
      });
    }
  });
});

describe('codes postaux et adresses', () => {
  it('valide et normalise les codes postaux canadiens', () => {
    expect(isValidCanadianPostalCode('H2L 2G8')).toBe(true);
    expect(isValidCanadianPostalCode('h2l2g8')).toBe(true);
    expect(isValidCanadianPostalCode('H2L-2G8')).toBe(true);
    expect(isValidCanadianPostalCode('D2L 2G8')).toBe(false); // D interdit
    expect(isValidCanadianPostalCode('W2L 2G8')).toBe(false); // W interdit en 1re position
    expect(isValidCanadianPostalCode('H2L 2G')).toBe(false);
    expect(isValidCanadianPostalCode('12345')).toBe(false);
    expect(normalizeCanadianPostalCode('h2l2g8')).toBe('H2L 2G8');
    expect(normalizeCanadianPostalCode('V6B-4Y8')).toBe('V6B 4Y8');
  });

  it('valide les ZIP américains', () => {
    expect(isValidUsZip('14201')).toBe(true);
    expect(isValidUsZip('14201-1234')).toBe(true);
    expect(isValidUsZip('1420')).toBe(false);
    expect(isValidUsZip('14201-12')).toBe(false);
    expect(isValidUsZip('H2L 2G8')).toBe(false);
  });

  it('checkoutAddressSchema : adresse canadienne valide, code postal normalisé', () => {
    const parsed = checkoutAddressSchema.parse({
      firstName: 'Marie',
      lastName: 'Tremblay',
      line1: '1234, rue Sainte-Catherine Est',
      city: 'Montréal',
      province: 'qc',
      postalCode: 'h2l2g8',
      country: 'CA',
    });
    expect(parsed.province).toBe('QC');
    expect(parsed.postalCode).toBe('H2L 2G8');
  });

  it('checkoutAddressSchema : refuse un état US avec pays CA et vice-versa', () => {
    expect(
      checkoutAddressSchema.safeParse({
        firstName: 'A',
        lastName: 'B',
        line1: 'x',
        city: 'Buffalo',
        province: 'NY',
        postalCode: 'H2L 2G8',
        country: 'CA',
      }).success,
    ).toBe(false);
    expect(
      checkoutAddressSchema.safeParse({
        firstName: 'A',
        lastName: 'B',
        line1: 'x',
        city: 'Buffalo',
        province: 'QC',
        postalCode: '14201',
        country: 'US',
      }).success,
    ).toBe(false);
  });

  it('checkoutAddressSchema : adresse américaine valide', () => {
    const parsed = checkoutAddressSchema.parse({
      firstName: 'John',
      lastName: 'Doe',
      line1: '1 Main St',
      city: 'Buffalo',
      province: 'ny',
      postalCode: '14201-0001',
      country: 'US',
      phone: '+1 (716) 555-0100',
    });
    expect(parsed.province).toBe('NY');
    expect(parsed.postalCode).toBe('14201-0001');
  });
});
