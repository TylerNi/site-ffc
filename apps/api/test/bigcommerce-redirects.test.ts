import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog } from '../src/bigcommerce/import';
import { InMemoryImageStore } from '../src/bigcommerce/images';
import {
  buildRedirects,
  loadCatalogTargets,
  type CatalogTargets,
  type RedirectDecisionRow,
  type RedirectHostConfig,
  type RedirectSourceRow,
} from '../src/bigcommerce/redirects';
import { buildImportPlan } from '../src/bigcommerce/transform';
import { buildUrlRows } from '../src/bigcommerce/urls-csv';
import { buildFixtureCatalogExport } from './fixtures/bigcommerce';
import { createTestClient } from './helpers';

const EN_HOST = 'www.furnacefilterscanada.com';
const FR_HOST = 'www.filtrationmontreal.com';

const hosts: RedirectHostConfig[] = [
  { host: EN_HOST, locale: 'en', aliases: ['furnacefilterscanada.com'] },
  { host: FR_HOST, locale: 'fr', aliases: ['filtrationmontreal.com'] },
];

/**
 * Bout-en-bout génération (tâche 25 §1) : fixtures BigCommerce importées en
 * base ffc_test → CSV d'URLs reconstruit comme à la tâche 08 → table de
 * redirections où CHAQUE URL a une décision, cibles = slugs réellement en
 * base.
 */
describe('bigcommerce/redirects — intégration (base ffc_test)', () => {
  let prisma: PrismaClient;
  let targets: CatalogTargets;
  let csvSources: RedirectSourceRow[];

  const catalogExport = buildFixtureCatalogExport();

  beforeAll(async () => {
    prisma = createTestClient();
    const { plan, productPairing, categoryPairing } = buildImportPlan(catalogExport);
    await importCatalog(prisma, plan, { dryRun: false, imageStore: new InMemoryImageStore() });
    targets = await loadCatalogTargets(prisma);

    csvSources = buildUrlRows(catalogExport, productPairing, categoryPairing).map((row) => ({
      host: row.domain === 'furnacefilterscanada.com' ? EN_HOST : FR_HOST,
      type: row.type,
      path: row.url,
      matchedId: row.matchedId,
      origin: 'csv' as const,
    }));
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { bigcommerceProductId: { not: null } } });
    await prisma.category.deleteMany({ where: { bigcommerceCategoryId: { not: null } } });
    await prisma.brand.deleteMany({ where: { bigcommerceBrandId: { not: null } } });
    await prisma.$disconnect();
  });

  it('les cibles viennent de la base : produits ACTIVE et catégories actives seulement', () => {
    expect(targets.products.get('en:301')).toEqual({
      en: '16x25x1-merv-11-furnace-filter',
      fr: 'filtre-fournaise-16x25x1-merv-11',
    });
    expect(targets.products.get('en:302')).toEqual({ en: '20x25x1-merv-8-furnace-filter' });
    expect(targets.categories.get('en:101')).toMatchObject({ en: 'bc-import-root/1-inch' });
    expect(targets.sizeLabels.has('16x25x1')).toBe(true);
  });

  it('sans décisions : toutes les pages CMS sortent en écart bloquant, rien d’autre', () => {
    const { artifact, gaps } = buildRedirects({
      hosts,
      sources: csvSources,
      decisions: [],
      targets,
    });
    expect(gaps.map((gap) => `${gap.host}${gap.path}`).sort()).toEqual([
      `${FR_HOST}/a-propos`,
      `${EN_HOST}/about-us`,
    ]);
    const enProducts = artifact.coverage.byHost[EN_HOST]!.product!;
    expect(enProducts.pending).toBe(0);
    expect(enProducts.exact).toBe(enProducts.total);
  });

  it('avec décisions : 100 % des URLs résolues, artefact complet et vérifié', () => {
    const decisions: RedirectDecisionRow[] = [
      { host: EN_HOST, path: '/about-us/', action: 'gone', reason: 'page non reprise' },
      { host: FR_HOST, path: '/a-propos/', action: 'gone', reason: 'page non reprise' },
      { host: EN_HOST, path: '/cart.php', action: 'redirect', to: '/cart', reason: 'panier' },
      { host: FR_HOST, path: '/cart.php', action: 'redirect', to: '/panier', reason: 'panier' },
    ];
    const crawlSources: RedirectSourceRow[] = [
      // Le crawl retrouve une URL déjà au CSV (dédupliquée) et la page d'accueil.
      { host: EN_HOST, type: 'other', path: '/16x25x1-MERV-11-furnace-filter/', origin: 'crawl' },
      { host: EN_HOST, type: 'other', path: '/', origin: 'crawl' },
    ];

    const { artifact, gaps, ignored } = buildRedirects({
      hosts,
      sources: [...csvSources, ...crawlSources],
      decisions,
      targets,
    });

    expect(gaps).toHaveLength(0);
    expect(ignored.map((row) => row.path)).toEqual(['/']);

    const en = artifact.hosts[EN_HOST]!;
    const fr = artifact.hosts[FR_HOST]!;

    expect(en.exact['/16x25x1-merv-11-furnace-filter']).toEqual({
      to: '/products/16x25x1-merv-11-furnace-filter',
      type: 'product',
      id: 'en:301',
    });
    expect(fr.exact['/filtre-fournaise-16x25x1-merv-11']).toEqual({
      to: '/produits/filtre-fournaise-16x25x1-merv-11',
      type: 'product',
      id: 'en:301',
    });
    expect(fr.exact['/racine-import-bc/1-pouce']).toEqual({
      to: '/categories/racine-import-bc/1-pouce',
      type: 'category',
      id: 'en:101',
    });
    expect(en.exact['/cart.php']).toMatchObject({ to: '/cart' });
    expect(en.gone).toEqual(['/about-us']);
    expect(fr.gone).toEqual(['/a-propos']);

    // Chaque URL source (CSV + crawl) atterrit dans exactement un état.
    for (const [host, byType] of Object.entries(artifact.coverage.byHost)) {
      for (const [type, cell] of Object.entries(byType)) {
        expect(cell.exact + cell.gone + cell.pending + cell.ignored, `${host} ${type}`).toBe(
          cell.total,
        );
      }
    }

    // Zéro chaîne : aucune cible n'est elle-même une clé de redirection/410.
    for (const table of [en, fr]) {
      const keys = new Set([...Object.keys(table.exact), ...table.gone]);
      for (const entry of Object.values(table.exact)) {
        expect(keys.has(entry.to.toLowerCase())).toBe(false);
      }
    }
  });

  it('import FR non exécuté (base sans traductions fr) : lignes FR en écart, jamais de 301 approximative', async () => {
    await prisma.productTranslation.deleteMany({
      where: { locale: 'fr', product: { bigcommerceProductId: { not: null } } },
    });
    const partialTargets = await loadCatalogTargets(prisma);

    const frProductRows = csvSources.filter(
      (row) => row.host === FR_HOST && row.type === 'product',
    );
    const { artifact, gaps } = buildRedirects({
      hosts,
      sources: frProductRows,
      decisions: [],
      targets: partialTargets,
    });

    expect(Object.keys(artifact.hosts[FR_HOST]!.exact)).toHaveLength(0);
    expect(gaps.length).toBe(frProductRows.length);
    for (const gap of gaps) {
      expect(gap.reason).toMatch(/Traduction fr manquante|absent de la base/);
    }
  });
});
