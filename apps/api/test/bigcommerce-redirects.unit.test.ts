import { describe, expect, it } from 'vitest';
import { normalizeRedirectPath, isTrackingParam } from '@ffc/core';
import {
  buildRedirects,
  isResolvableTarget,
  productPath,
  type BuildRedirectsInput,
  type CatalogTargets,
  type RedirectHostConfig,
} from '../src/bigcommerce/redirects';

const EN_HOST = 'www.filters-test.com';
const FR_HOST = 'www.filtration-test.com';

const hosts: RedirectHostConfig[] = [
  { host: EN_HOST, locale: 'en', aliases: ['filters-test.com'] },
  { host: FR_HOST, locale: 'fr', aliases: ['filtration-test.com'] },
];

function targets(overrides?: Partial<CatalogTargets>): CatalogTargets {
  return {
    products: new Map([
      ['en:34', { en: 'M8-1056', fr: 'filtre-m8-1056' }],
      ['en:35', { en: 'filter-16x25x1' }],
    ]),
    categories: new Map([['en:7', { en: 'furnace-filters', fr: 'filtres-fournaise' }]]),
    sizeLabels: new Set(['16x25x1']),
    ...overrides,
  };
}

function input(partial: Partial<BuildRedirectsInput>): BuildRedirectsInput {
  return { hosts, sources: [], decisions: [], targets: targets(), ...partial };
}

/**
 * Générateur de la table de redirections (tâche 25 §1/§3) : une URL source =
 * une décision explicite; cibles résolues sur les slugs ACTUELS; zéro chaîne,
 * zéro boucle; tout écart sort dans le rapport bloquant.
 */
describe('bigcommerce/redirects — normalisation partagée', () => {
  it('normalise casse, slashes et encodage, racine préservée', () => {
    expect(normalizeRedirectPath('/M8-1056/')).toBe('/m8-1056');
    expect(normalizeRedirectPath('//double//slash/')).toBe('/double/slash');
    expect(normalizeRedirectPath('/%4d8-1056')).toBe('/m8-1056');
    expect(normalizeRedirectPath('/')).toBe('/');
    expect(normalizeRedirectPath('sans-slash')).toBe('/sans-slash');
    expect(normalizeRedirectPath('/index.php')).toBe('/index.php');
  });

  it('préserve uniquement les paramètres de suivi marketing', () => {
    expect(isTrackingParam('utm_source')).toBe(true);
    expect(isTrackingParam('UTM_Campaign')).toBe(true);
    expect(isTrackingParam('gclid')).toBe(true);
    expect(isTrackingParam('sort')).toBe(false);
    expect(isTrackingParam('page')).toBe(false);
    expect(isTrackingParam('search_query')).toBe(false);
  });
});

describe('bigcommerce/redirects — résolution par identifiant', () => {
  it('résout un produit apparié : clé normalisée, slug de la base verbatim', () => {
    const { artifact, gaps } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'product', path: '/M8-1056/', matchedId: 'en:34', origin: 'csv' },
          {
            host: FR_HOST,
            type: 'product',
            path: '/filtre-M8-1056/',
            matchedId: 'en:34',
            origin: 'csv',
          },
        ],
      }),
    );
    expect(gaps).toHaveLength(0);
    expect(artifact.hosts[EN_HOST]!.exact['/m8-1056']).toEqual({
      to: '/products/M8-1056',
      type: 'product',
      id: 'en:34',
    });
    expect(artifact.hosts[FR_HOST]!.exact['/filtre-m8-1056']).toEqual({
      to: '/produits/filtre-m8-1056',
      type: 'product',
      id: 'en:34',
    });
  });

  it('résout une catégorie appariée vers /categories localisé', () => {
    const { artifact } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'category', path: '/furnace/', matchedId: 'en:7', origin: 'csv' },
        ],
      }),
    );
    expect(artifact.hosts[EN_HOST]!.exact['/furnace']).toEqual({
      to: '/categories/furnace-filters',
      type: 'category',
      id: 'en:7',
    });
  });

  it('le CSV prime sur le crawl pour un même chemin (id apparié conservé)', () => {
    const { artifact } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'other', path: '/m8-1056/', origin: 'crawl' },
          { host: EN_HOST, type: 'product', path: '/M8-1056/', matchedId: 'en:34', origin: 'csv' },
        ],
      }),
    );
    expect(artifact.hosts[EN_HOST]!.exact['/m8-1056']!.id).toBe('en:34');
    expect(artifact.coverage.byHost[EN_HOST]!.product?.total).toBe(1);
  });

  it('écarts : id absent de la base, traduction manquante, crawl sans id', () => {
    const { artifact, gaps } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'product', path: '/inconnu/', matchedId: 'en:999', origin: 'csv' },
          {
            host: FR_HOST,
            type: 'product',
            path: '/filtre-16x25/',
            matchedId: 'en:35',
            origin: 'csv',
          },
          { host: EN_HOST, type: 'product', path: '/decouverte/', origin: 'crawl' },
        ],
      }),
    );
    expect(gaps).toHaveLength(3);
    expect(gaps.map((gap) => gap.path).sort()).toEqual([
      '/decouverte',
      '/filtre-16x25',
      '/inconnu',
    ]);
    expect(gaps.find((gap) => gap.path === '/filtre-16x25')?.reason).toContain('Traduction fr');
    expect(Object.keys(artifact.hosts[EN_HOST]!.exact)).toHaveLength(0);
    const cell = artifact.coverage.byHost[EN_HOST]!.product;
    expect(cell).toMatchObject({ total: 2, pending: 2, exact: 0 });
  });

  it('pages, blogue et marques sans décision → écarts aux raisons dédiées', () => {
    const { gaps } = buildRedirects(
      input({
        sources: [
          {
            host: EN_HOST,
            type: 'page',
            path: '/shipping/',
            matchedId: 'en:page:1',
            origin: 'csv',
          },
          { host: EN_HOST, type: 'blog', path: '/blog/hello/', origin: 'crawl' },
          { host: EN_HOST, type: 'brand', path: '/brands/acme/', origin: 'crawl' },
        ],
      }),
    );
    expect(gaps).toHaveLength(3);
    expect(gaps.find((gap) => gap.type === 'blog')?.reason).toContain('blogue');
    expect(gaps.find((gap) => gap.type === 'brand')?.reason).toContain('marque');
    expect(gaps.find((gap) => gap.type === 'page')?.reason).toContain('Page CMS');
  });
});

describe('bigcommerce/redirects — décisions versionnées', () => {
  it('applique redirect/gone/pending, y compris les décisions orphelines', () => {
    const { artifact, gaps } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'page', path: '/about/', matchedId: 'en:page:2', origin: 'csv' },
          { host: EN_HOST, type: 'page', path: '/old-promo/', origin: 'crawl' },
          { host: EN_HOST, type: 'blog', path: '/blog/post/', origin: 'crawl' },
        ],
        decisions: [
          { host: EN_HOST, path: '/about/', action: 'redirect', to: '/sizes', reason: 'reprise' },
          { host: EN_HOST, path: '/old-promo/', action: 'gone', reason: 'promo terminée' },
          { host: EN_HOST, path: '/blog/post/', action: 'pending', reason: 'attente rapport SEO' },
          { host: EN_HOST, path: '/cart.php', action: 'redirect', to: '/cart', reason: 'panier' },
        ],
      }),
    );
    expect(artifact.hosts[EN_HOST]!.exact['/about']).toMatchObject({ to: '/sizes', type: 'page' });
    expect(artifact.hosts[EN_HOST]!.exact['/cart.php']).toMatchObject({
      to: '/cart',
      type: 'other',
    });
    expect(artifact.hosts[EN_HOST]!.gone).toEqual(['/old-promo']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ path: '/blog/post', origin: 'decision' });
    expect(artifact.coverage.byHost[EN_HOST]!.other).toMatchObject({ total: 1, exact: 1 });
  });

  it('refuse une cible de décision qui ne se résout pas sur la vitrine', () => {
    expect(() =>
      buildRedirects(
        input({
          decisions: [
            { host: EN_HOST, path: '/x/', action: 'redirect', to: '/nowhere', reason: 'test' },
          ],
        }),
      ),
    ).toThrow(/introuvable/);
  });

  it('refuse doublons de décision, hôte inconnu et redirect sans cible', () => {
    expect(() =>
      buildRedirects(
        input({
          decisions: [
            { host: EN_HOST, path: '/a/', action: 'gone', reason: 'x' },
            { host: EN_HOST, path: '/A', action: 'gone', reason: 'y' },
          ],
        }),
      ),
    ).toThrow(/en double/);
    expect(() =>
      buildRedirects(
        input({ decisions: [{ host: 'autre.com', path: '/a', action: 'gone', reason: 'x' }] }),
      ),
    ).toThrow(/hôte inconnu/);
    expect(() =>
      buildRedirects(
        input({ decisions: [{ host: EN_HOST, path: '/a', action: 'redirect', reason: 'x' }] }),
      ),
    ).toThrow(/sans cible/);
  });
});

describe('bigcommerce/redirects — garanties zéro chaîne / zéro boucle', () => {
  it('refuse une boucle (cible normalisée = clé)', () => {
    expect(() =>
      buildRedirects(
        input({
          sources: [
            {
              host: EN_HOST,
              type: 'product',
              path: '/products/M8-1056/',
              matchedId: 'en:34',
              origin: 'csv',
            },
          ],
        }),
      ),
    ).toThrow(/Boucle/);
  });

  it('refuse une chaîne (cible elle-même clé de redirection)', () => {
    expect(() =>
      buildRedirects(
        input({
          sources: [
            {
              host: EN_HOST,
              type: 'product',
              path: '/M8-1056/',
              matchedId: 'en:34',
              origin: 'csv',
            },
          ],
          decisions: [
            {
              host: EN_HOST,
              path: '/products/m8-1056',
              action: 'gone',
              reason: 'conflit délibéré',
            },
          ],
        }),
      ),
    ).toThrow(/Chaîne/);
  });

  it('une décision sur un chemin source PRIME sur la résolution par id', () => {
    const { artifact } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'product', path: '/x/', matchedId: 'en:34', origin: 'csv' },
        ],
        decisions: [{ host: EN_HOST, path: '/x', action: 'gone', reason: 'retrait assumé' }],
      }),
    );
    expect(artifact.hosts[EN_HOST]!.gone).toEqual(['/x']);
    expect(artifact.hosts[EN_HOST]!.exact['/x']).toBeUndefined();
  });
});

describe('bigcommerce/redirects — ignorés et couverture', () => {
  it('ignore URLs vides et chemins identiques sur la nouvelle plateforme', () => {
    const { artifact, ignored } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'page', path: '', matchedId: 'en:page:9', origin: 'csv' },
          { host: EN_HOST, type: 'page', path: '/', origin: 'crawl' },
          { host: EN_HOST, type: 'other', path: '/sitemap.xml', origin: 'crawl' },
        ],
      }),
    );
    expect(ignored).toHaveLength(3);
    expect(artifact.coverage.byHost[EN_HOST]!.page?.ignored).toBe(1);
    expect(artifact.coverage.byHost[EN_HOST]!.other?.ignored).toBe(1);
  });

  it("l'équation de couverture tient : total = exact + gone + pending + ignored", () => {
    const { artifact } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'product', path: '/M8-1056/', matchedId: 'en:34', origin: 'csv' },
          { host: EN_HOST, type: 'product', path: '/perdu/', matchedId: 'en:404', origin: 'csv' },
          { host: EN_HOST, type: 'product', path: '/', origin: 'crawl' },
        ],
        decisions: [{ host: EN_HOST, path: '/retire/', action: 'gone', reason: '410' }],
      }),
    );
    const product = artifact.coverage.byHost[EN_HOST]!.product!;
    expect(product.total).toBe(3);
    expect(product.exact + product.gone + product.pending + product.ignored).toBe(3);
    const other = artifact.coverage.byHost[EN_HOST]!.other!;
    expect(other.total).toBe(1);
    expect(other.gone).toBe(1);
  });

  it('trie les clés exact et les gone pour un artefact reproductible', () => {
    const { artifact } = buildRedirects(
      input({
        sources: [
          { host: EN_HOST, type: 'product', path: '/zz/', matchedId: 'en:34', origin: 'csv' },
          { host: EN_HOST, type: 'category', path: '/aa/', matchedId: 'en:7', origin: 'csv' },
        ],
        decisions: [
          { host: EN_HOST, path: '/z-gone', action: 'gone', reason: 'x' },
          { host: EN_HOST, path: '/a-gone', action: 'gone', reason: 'y' },
        ],
      }),
    );
    expect(Object.keys(artifact.hosts[EN_HOST]!.exact)).toEqual(['/aa', '/zz']);
    expect(artifact.hosts[EN_HOST]!.gone).toEqual(['/a-gone', '/z-gone']);
  });
});

describe('bigcommerce/redirects — cibles résolvables', () => {
  it('statiques localisées, fiches par slug, tailles du référentiel', () => {
    const t = targets();
    expect(isResolvableTarget('en', '/sizes', t)).toBe(true);
    expect(isResolvableTarget('fr', '/tailles/16x25x1', t)).toBe(true);
    expect(isResolvableTarget('fr', '/tailles/99x99x9', t)).toBe(false);
    expect(isResolvableTarget('en', productPath('en', 'M8-1056'), t)).toBe(true);
    expect(isResolvableTarget('fr', '/produits/filtre-m8-1056', t)).toBe(true);
    expect(isResolvableTarget('fr', '/produits/M8-1056', t)).toBe(false);
    expect(isResolvableTarget('en', '/random', t)).toBe(false);
  });
});
