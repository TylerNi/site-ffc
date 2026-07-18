import { describe, expect, it } from 'vitest';
import {
  dollarsToCents,
  poundsToGrams,
  resolveDimension,
  resolveMerv,
  resolvePackSize,
} from '../src/bigcommerce/mapping';

/**
 * Extraction taille/MERV/format de boîte depuis les données BigCommerce
 * (tâche 08 §3) — options de variante > champs personnalisés > nom du produit.
 */
describe('bigcommerce/mapping', () => {
  describe('resolveDimension', () => {
    it('lit la taille depuis une option de variante et la résout au référentiel @ffc/core', () => {
      const result = resolveDimension(
        'Some Furnace Filter',
        [{ option_display_name: 'Size', label: '16x25x1' }],
        [],
      );
      expect(result?.size?.nominal).toBe('16x25x1');
      expect(result?.size?.actualDimensions).toEqual({ width: 15.75, height: 24.75, depth: 0.75 });
    });

    it('retombe sur le nom du produit quand aucune option ne correspond', () => {
      const result = resolveDimension('Furnace Filter 20x25x1 MERV 8', [], []);
      expect(result?.size?.nominal).toBe('20x25x1');
    });

    it('lit un champ personnalisé si ni option ni nom ne donnent la taille', () => {
      const result = resolveDimension(
        'Filtre générique',
        [],
        [{ id: 1, name: 'Taille', value: '16x20x1' }],
      );
      expect(result?.size?.nominal).toBe('16x20x1');
    });

    it('taille non reconnue du référentiel → size null (pas de fabrication)', () => {
      const result = resolveDimension('', [{ option_display_name: 'Size', label: '17x99x1' }], []);
      expect(result?.size).toBeNull();
      expect(result?.raw).toBe('17x99x1');
    });

    it('extrait la dimension d’un libellé d’option enrichi (« 12x24x1 (12-Pack) 286$ »)', () => {
      const result = resolveDimension(
        'Furnace filter',
        [{ option_display_name: 'Size', label: '12x24x1 (12-Pack) 286$' }],
        [],
      );
      expect(result?.size?.nominal).toBe('12x24x1');
    });

    it('lit les tailles fractionnaires avec marques de pouces (« 19 3/4" x 20 1/2" x 4 7/8" »)', () => {
      const result = resolveDimension('19 3/4" x 20 1/2" x 4 7/8". (3-pack)', [], []);
      expect(result?.size?.nominal).toBe('19.75x20.5x4.88');
      expect(result?.size?.actualDimensions).toEqual({ width: 19.75, height: 20.5, depth: 4.88 });
    });

    it('aucune dimension repérable → null', () => {
      expect(resolveDimension('Produit sans taille', [], [])).toBeNull();
    });
  });

  describe('resolveMerv', () => {
    it('lit le MERV depuis une option de variante', () => {
      expect(resolveMerv('x', [{ option_display_name: 'MERV', label: '11' }], [])).toBe(11);
    });

    it('lit le MERV depuis le nom du produit', () => {
      expect(resolveMerv('Furnace Filter MERV-13', [], [])).toBe(13);
    });

    it('valeur hors plage ASHRAE (1-20) → null', () => {
      expect(resolveMerv('Furnace Filter MERV 99', [], [])).toBeNull();
    });

    it('absent → null (ex. pré-filtres non cotés)', () => {
      expect(resolveMerv('Pre-Filter', [], [])).toBeNull();
    });
  });

  describe('resolvePackSize', () => {
    it('lit le format depuis une option de variante', () => {
      expect(
        resolvePackSize('x', 'sku', [{ option_display_name: 'Pack', label: 'Box of 6' }], []),
      ).toBe(6);
    });

    it('lit le format depuis le nom du produit (« Box of N »)', () => {
      expect(resolvePackSize('Furnace Filter - Box of 4', 'sku', [], [])).toBe(4);
    });

    it('lit le format en français (« Boîte de N »)', () => {
      expect(resolvePackSize('Filtre - Boîte de 12', 'sku', [], [])).toBe(12);
    });

    it('lit le format embarqué dans un libellé d’option de taille', () => {
      expect(
        resolvePackSize(
          'Furnace filter',
          'sku',
          [{ option_display_name: 'Size', label: '12x24x1 (12-Pack) 286$' }],
          [],
        ),
      ).toBe(12);
    });

    it('un prix dans l’option dédiée ne pollue pas le compte (« 12-Pack 174$ » → 12)', () => {
      expect(
        resolvePackSize('x', 'sku', [{ option_display_name: 'Pack', label: '12-Pack 174$' }], []),
      ).toBe(12);
    });

    it('défaut : 1 (vente à l’unité)', () => {
      expect(resolvePackSize('Furnace Filter', 'sku', [], [])).toBe(1);
    });
  });

  describe('conversions', () => {
    it('livres → grammes', () => {
      expect(poundsToGrams(1)).toBe(454);
      expect(poundsToGrams(null)).toBeNull();
      expect(poundsToGrams(0)).toBeNull();
    });

    it('dollars → cents', () => {
      expect(dollarsToCents(59.99)).toBe(5999);
      expect(dollarsToCents(null)).toBeNull();
    });
  });
});
