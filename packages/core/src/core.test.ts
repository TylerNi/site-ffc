import { describe, expect, it } from 'vitest';
import {
  combinedTaxRate,
  findMervRating,
  findNominalSize,
  healthStatusSchema,
  localeSchema,
  NOMINAL_FILTER_SIZES,
  nominalSizeLabelSchema,
  PROVINCE_CODES,
  PROVINCES,
} from './index';

describe('locales', () => {
  it('accepte fr et en, refuse le reste', () => {
    expect(localeSchema.parse('fr')).toBe('fr');
    expect(localeSchema.parse('en')).toBe('en');
    expect(localeSchema.safeParse('de').success).toBe(false);
  });
});

describe('tailles de filtres', () => {
  it('les dimensions réelles ne dépassent jamais les nominales (strictement moindres pour les tailles standard)', () => {
    for (const size of NOMINAL_FILTER_SIZES) {
      expect(size.actualDimensions.width).toBeLessThanOrEqual(size.nominalDimensions.width);
      expect(size.actualDimensions.height).toBeLessThanOrEqual(size.nominalDimensions.height);
      expect(size.actualDimensions.depth).toBeLessThanOrEqual(size.nominalDimensions.depth);
      if (!size.nominal.includes('.')) {
        expect(size.actualDimensions.width).toBeLessThan(size.nominalDimensions.width);
        expect(size.actualDimensions.height).toBeLessThan(size.nominalDimensions.height);
        expect(size.actualDimensions.depth).toBeLessThan(size.nominalDimensions.depth);
      }
    }
  });

  it('les libellés nominaux respectent le format LxHxP', () => {
    for (const size of NOMINAL_FILTER_SIZES) {
      expect(nominalSizeLabelSchema.safeParse(size.nominal).success).toBe(true);
    }
  });

  it('les libellés nominaux sont uniques', () => {
    const labels = NOMINAL_FILTER_SIZES.map((size) => size.nominal);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('retrouve une taille par libellé', () => {
    expect(findNominalSize('16x25x1')?.actualDimensions.depth).toBe(0.75);
    expect(findNominalSize('10x20x2')?.actualDimensions).toEqual({
      width: 9.75,
      height: 19.75,
      depth: 1.75,
    });
    expect(findNominalSize('20.25x25.38x5.25')?.actualDimensions.depth).toBe(5.25);
    expect(findNominalSize('99x99x9')).toBeUndefined();
  });
});

describe('cotes MERV', () => {
  it('expose des descriptions bilingues', () => {
    const merv13 = findMervRating(13);
    expect(merv13).toBeDefined();
    expect(merv13?.description.fr.length).toBeGreaterThan(0);
    expect(merv13?.description.en.length).toBeGreaterThan(0);
  });
});

describe('provinces et taxes', () => {
  it('couvre les 13 provinces et territoires', () => {
    expect(PROVINCE_CODES).toHaveLength(13);
    expect(Object.keys(PROVINCES)).toHaveLength(13);
  });

  it('le Québec applique TPS + TVQ', () => {
    const kinds = PROVINCES.QC.taxes.map((tax) => tax.kind);
    expect(kinds).toEqual(['GST', 'QST']);
    expect(combinedTaxRate('QC')).toBeCloseTo(0.14975, 5);
  });
});

describe('santé API', () => {
  it('valide une réponse conforme', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      service: 'ffc-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 12,
    });
    expect(result.success).toBe(true);
  });

  it('refuse un statut inconnu', () => {
    const result = healthStatusSchema.safeParse({
      status: 'down',
      service: 'ffc-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 12,
    });
    expect(result.success).toBe(false);
  });
});
