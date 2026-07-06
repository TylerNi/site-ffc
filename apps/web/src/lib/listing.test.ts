import { describe, expect, it } from 'vitest';
import { filtersToQuery, hasActiveFilters, parseListingFilters } from './listing';

describe('parseListingFilters', () => {
  it('lit les filtres valides', () => {
    expect(
      parseListingFilters({
        dimension: '16x25x1',
        merv: '11',
        depth: '4',
        inStock: 'true',
        sort: 'price',
        cursor: 'abc',
      }),
    ).toEqual({
      dimension: '16x25x1',
      merv: 11,
      depth: 4,
      inStock: true,
      sort: 'price',
      cursor: 'abc',
    });
  });

  it('ignore les valeurs invalides sans casser', () => {
    const filters = parseListingFilters({
      merv: 'abc',
      depth: '99',
      inStock: 'peut-être',
      sort: 'hacker',
      dimension: '   ',
    });
    expect(filters).toEqual({
      dimension: undefined,
      merv: undefined,
      depth: undefined,
      inStock: undefined,
      sort: undefined,
      cursor: undefined,
    });
    expect(hasActiveFilters(filters)).toBe(false);
  });

  it('prend la première valeur des paramètres répétés', () => {
    expect(parseListingFilters({ merv: ['8', '11'] }).merv).toBe(8);
  });
});

describe('hasActiveFilters', () => {
  it('un tri « relevance » seul n’est pas un filtre actif', () => {
    expect(hasActiveFilters(parseListingFilters({ sort: 'relevance' }))).toBe(false);
    expect(hasActiveFilters(parseListingFilters({ sort: 'price' }))).toBe(true);
    expect(hasActiveFilters(parseListingFilters({ cursor: 'x' }))).toBe(true);
  });
});

describe('filtersToQuery', () => {
  it('omet le curseur et les valeurs absentes', () => {
    expect(
      filtersToQuery(parseListingFilters({ merv: '11', cursor: 'abc', inStock: 'true' })),
    ).toEqual({ merv: '11', inStock: 'true' });
  });
});
