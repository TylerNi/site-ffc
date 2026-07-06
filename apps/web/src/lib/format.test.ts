import { describe, expect, it } from 'vitest';
import { formatCents, formatCentsRange, formatDimensions, formatList, jsonLdPrice } from './format';

describe('formatCents', () => {
  it('fr-CA : symbole après, virgule décimale', () => {
    // Intl insère des espaces insécables — on normalise pour l'assertion.
    expect(formatCents(1399, 'CAD', 'fr').replace(/\s/g, ' ')).toBe('13,99 $');
  });

  it('en-CA : symbole avant, point décimal', () => {
    expect(formatCents(1399, 'CAD', 'en')).toBe('$13.99');
  });

  it('fourchette compacte, identique si bornes égales', () => {
    expect(formatCentsRange(1399, 1399, 'CAD', 'en')).toBe('$13.99');
    expect(formatCentsRange(1399, 7199, 'CAD', 'en')).toBe('$13.99 – $71.99');
  });
});

describe('jsonLdPrice', () => {
  it('décimal à point, deux décimales (schema.org)', () => {
    expect(jsonLdPrice(1399)).toBe('13.99');
    expect(jsonLdPrice(1000)).toBe('10.00');
  });
});

describe('formatDimensions', () => {
  it('localise séparateur décimal et unité', () => {
    const dims = { width: 15.75, height: 24.75, depth: 0.75 };
    expect(formatDimensions(dims, 'fr').replace(/\s/g, ' ')).toBe('15,75 × 24,75 × 0,75 po');
    expect(formatDimensions(dims, 'en')).toBe('15.75 × 24.75 × 0.75 in');
  });
});

describe('formatList', () => {
  it('conjonction localisée', () => {
    expect(formatList([8, 11, 13], 'fr')).toBe('8, 11 et 13');
    expect(formatList([8, 11, 13], 'en')).toBe('8, 11 and 13');
  });
});
