import { describe, expect, it } from 'vitest';
import {
  canonicalDimensionLabel,
  dimensionEquivalents,
  extractDimension,
  looksLikeDimension,
  parseDimensionInput,
} from './dimensions';

describe('parseDimensionInput — formats d’écriture', () => {
  const variants = ['16x25x1', '16 x 25 x 1', '16-25-1', '16*25*1', '16 by 25 by 1', '16X25X1'];

  it('toutes les graphies d’une même taille s’analysent identiquement', () => {
    for (const variant of variants) {
      expect(parseDimensionInput(variant)).toEqual({ width: 16, height: 25, depth: 1 });
    }
  });

  it('accepte deux composantes (profondeur omise)', () => {
    expect(parseDimensionInput('16x25')).toEqual({ width: 16, height: 25, depth: null });
  });

  it('accepte décimales et fractions (dimensions réelles)', () => {
    expect(parseDimensionInput('15.75 x 24.75 x 0.75')).toEqual({
      width: 15.75,
      height: 24.75,
      depth: 0.75,
    });
    expect(parseDimensionInput('15 3/4 x 24 3/4 x 3/4')).toEqual({
      width: 15.75,
      height: 24.75,
      depth: 0.75,
    });
  });

  it('rejette les saisies non dimensionnelles', () => {
    expect(parseDimensionInput('bonjour')).toBeNull();
    expect(parseDimensionInput('16')).toBeNull();
    expect(parseDimensionInput('16x25x1x3')).toBeNull();
    expect(parseDimensionInput('0x25x1')).toBeNull();
  });
});

describe('canonicalDimensionLabel', () => {
  it('formate sans zéros superflus', () => {
    expect(canonicalDimensionLabel({ width: 16, height: 25, depth: 1 })).toBe('16x25x1');
    expect(canonicalDimensionLabel({ width: 16, height: 25, depth: null })).toBe('16x25');
    expect(canonicalDimensionLabel({ width: 15.75, height: 24.75, depth: 0.75 })).toBe(
      '15.75x24.75x0.75',
    );
  });
});

describe('extractDimension — requête mixte', () => {
  it('isole la dimension et le texte résiduel', () => {
    expect(extractDimension('filtre 16x25x1 merv 11')).toEqual({
      dimension: '16x25x1',
      rest: 'filtre merv 11',
    });
  });

  it('gère une requête purement dimensionnelle au tiret', () => {
    expect(extractDimension('16-25-1')).toEqual({ dimension: '16-25-1', rest: '' });
  });

  it('ne capture pas « merv-11 » comme une dimension', () => {
    expect(extractDimension('merv-11')).toBeNull();
  });

  it('retourne null sans dimension', () => {
    expect(extractDimension('pureflow')).toBeNull();
  });
});

describe('dimensionEquivalents — nominal ↔ réel', () => {
  it('le nominal retrouve sa propre taille', () => {
    const result = dimensionEquivalents('16x25x1');
    expect(result?.labels).toContain('16x25x1');
    expect(result?.canonical).toBe('16x25x1');
  });

  it('les dimensions réelles retrouvent la taille nominale', () => {
    const result = dimensionEquivalents('15 3/4 x 24 3/4 x 3/4');
    expect(result?.labels).toContain('16x25x1');
  });

  it('l’orientation est interchangeable (25x16x1 ≡ 16x25x1)', () => {
    const result = dimensionEquivalents('25x16x1');
    expect(result?.labels).toContain('16x25x1');
  });

  it('sans profondeur, toutes les profondeurs de cette face correspondent', () => {
    const result = dimensionEquivalents('16x25');
    expect(result?.labels).toEqual(expect.arrayContaining(['16x25x1', '16x25x4', '16x25x5']));
  });

  it('distingue 4 po et 5 po (profondeurs réelles proches)', () => {
    expect(dimensionEquivalents('16x25x4')?.labels).toEqual(['16x25x4']);
    expect(dimensionEquivalents('16x25x5')?.labels).toEqual(['16x25x5']);
  });

  it('une taille hors référentiel reste analysable (canonique formaté)', () => {
    const result = dimensionEquivalents('10x30x2');
    expect(result?.labels).toEqual([]);
    expect(result?.canonical).toBe('10x30x2');
  });

  it('retourne null pour une saisie invalide', () => {
    expect(dimensionEquivalents('pas une taille')).toBeNull();
  });
});

describe('looksLikeDimension', () => {
  it('reconnaît une dimension, rejette du texte', () => {
    expect(looksLikeDimension('20x20x1')).toBe(true);
    expect(looksLikeDimension('nordicair')).toBe(false);
  });
});
