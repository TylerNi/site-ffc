import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import fr from './locales/fr.json';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('dictionnaires i18n', () => {
  it('fr et en exposent exactement les mêmes clés', () => {
    expect(flattenKeys(fr).sort()).toEqual(flattenKeys(en).sort());
  });

  it('aucune valeur vide', () => {
    for (const dictionary of [fr, en]) {
      for (const key of flattenKeys(dictionary)) {
        const value = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], dictionary);
        expect(value, `clé vide : ${key}`).not.toBe('');
      }
    }
  });
});
