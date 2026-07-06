import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absoluteUrl, localeForHost, localizedPath, sharedHost, siteOrigin } from './site';

/**
 * Deux modes d'URL :
 *  - dev (aucune env) : origine partagée, français préfixé `/fr`;
 *  - production (env par locale) : un domaine par locale, jamais de préfixe.
 */

const ENV_KEYS = ['NEXT_PUBLIC_SITE_URL_FR', 'NEXT_PUBLIC_SITE_URL_EN'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setProductionDomains() {
  process.env.NEXT_PUBLIC_SITE_URL_FR = 'https://filtrationmontreal.com';
  process.env.NEXT_PUBLIC_SITE_URL_EN = 'https://furnacefilterscanada.com';
}

describe('mode dev (origine partagée)', () => {
  it('préfixe le français, laisse l’anglais nu', () => {
    expect(sharedHost()).toBe(true);
    expect(localizedPath('en', '/sizes')).toBe('/sizes');
    expect(localizedPath('fr', '/sizes')).toBe('/fr/tailles');
    expect(localizedPath('fr', '/')).toBe('/fr');
    expect(localizedPath('en', '/')).toBe('/');
  });

  it('localise les segments et les paramètres', () => {
    expect(
      localizedPath('fr', { pathname: '/products/[slug]', params: { slug: 'filtre-16x25x1' } }),
    ).toBe('/fr/produits/filtre-16x25x1');
    expect(
      localizedPath('en', { pathname: '/products/[slug]', params: { slug: 'filter-16x25x1' } }),
    ).toBe('/products/filter-16x25x1');
    expect(localizedPath('fr', '/search')).toBe('/fr/recherche');
  });

  it('construit des URL absolues localhost', () => {
    expect(absoluteUrl('en', '/')).toBe('http://localhost:3000/');
    expect(absoluteUrl('fr', '/sizes')).toBe('http://localhost:3000/fr/tailles');
  });

  it('reconnaît l’hôte partagé et rejette les inconnus', () => {
    expect(localeForHost('localhost:3000')).toBe('shared');
    expect(localeForHost('staging.example.com')).toBeNull();
  });
});

describe('mode production (un domaine par locale)', () => {
  beforeEach(setProductionDomains);

  it('ne préfixe jamais — le domaine porte la locale', () => {
    expect(sharedHost()).toBe(false);
    expect(localizedPath('fr', '/sizes')).toBe('/tailles');
    expect(localizedPath('fr', '/')).toBe('/');
    expect(absoluteUrl('fr', '/sizes')).toBe('https://filtrationmontreal.com/tailles');
    expect(absoluteUrl('en', '/sizes')).toBe('https://furnacefilterscanada.com/sizes');
    expect(absoluteUrl('fr', '/')).toBe('https://filtrationmontreal.com/');
  });

  it('résout la locale de chaque domaine', () => {
    expect(localeForHost('filtrationmontreal.com')).toBe('fr');
    expect(localeForHost('FURNACEFILTERSCANADA.com')).toBe('en');
    expect(localeForHost('localhost:3000')).toBeNull();
  });

  it('siteOrigin tolère la barre oblique finale', () => {
    process.env.NEXT_PUBLIC_SITE_URL_FR = 'https://filtrationmontreal.com/';
    expect(siteOrigin('fr')).toBe('https://filtrationmontreal.com');
  });
});
