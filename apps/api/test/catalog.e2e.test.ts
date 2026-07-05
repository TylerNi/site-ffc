import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTestContext, createTestApp } from './auth-helpers';

/**
 * Tests e2e du catalogue et de la recherche (tâche 06). Exercent l'app Nest
 * complète sur la base ffc_test seedée (40 produits, 110 variantes, 3 marques).
 */
describe('catalogue et recherche (tâche 06)', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const get = (path: string) => ctx.http().get(path);

  /* ----------------------------- Catégories ---------------------------- */

  describe('GET /catalog/categories', () => {
    it('retourne un arbre localisé avec comptes de sous-arbre', async () => {
      const { body, headers } = await get('/v1/catalog/categories?locale=fr').expect(200);
      expect(headers['cache-control']).toContain('public');

      const roots = body.categories as Array<{
        slug: string;
        name: string;
        productCount: number;
        children: unknown[];
      }>;
      const parent = roots.find((c) => c.slug === 'filtres-de-fournaise');
      expect(parent).toBeDefined();
      expect(parent!.name).toBe('Filtres de fournaise');
      // Le parent agrège ses 3 sous-catégories → les 40 produits.
      expect(parent!.productCount).toBe(40);
      expect(parent!.children).toHaveLength(3);
    });

    it('localise en anglais', async () => {
      const { body } = await get('/v1/catalog/categories?locale=en').expect(200);
      const slugs = (body.categories as Array<{ slug: string }>).map((c) => c.slug);
      expect(slugs).toContain('furnace-filters');
    });
  });

  /* --------------------------- Liste produits -------------------------- */

  describe('GET /catalog/products', () => {
    it('liste par défaut : produit vedette en tête (tri pertinence)', async () => {
      const { body } = await get('/v1/catalog/products?locale=fr&limit=5').expect(200);
      expect(body.items.length).toBe(5);
      expect(body.items[0].isFeatured).toBe(true);
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBeTruthy();
    });

    it('pagination par curseur : stable et sans doublon', async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/v1/catalog/products?locale=fr&limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const { body } = await get(url).expect(200);
        for (const item of body.items as Array<{ id: string }>) {
          expect(seen.has(item.id)).toBe(false); // aucun doublon entre pages
          seen.add(item.id);
        }
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen.size).toBe(40); // le catalogue entier, une seule fois
    });

    it('tri par prix croissant', async () => {
      const { body } = await get('/v1/catalog/products?sort=price&limit=40').expect(200);
      const prices = (body.items as Array<{ priceFromCents: number }>).map((i) => i.priceFromCents);
      const sorted = [...prices].sort((a, b) => a - b);
      expect(prices).toEqual(sorted);
    });

    it('filtre combiné : 16x25x1 + MERV 11 + marque → 1 produit', async () => {
      const { body } = await get(
        '/v1/catalog/products?dimension=16x25x1&merv=11&brand=boreal-filtration',
      ).expect(200);
      expect(body.items).toHaveLength(1);
      const item = body.items[0];
      expect(item.brand.slug).toBe('boreal-filtration');
      expect(item.mervValues).toEqual([11]);
      expect(item.nominalLabels).toEqual(['16x25x1']);
    });

    it('16x25x1 sans MERV → 3 produits (MERV 8/11/13)', async () => {
      const { body } = await get('/v1/catalog/products?dimension=16x25x1').expect(200);
      expect(body.items).toHaveLength(3);
    });

    it('filtre par type d’équipement (fournaise)', async () => {
      const { body } = await get('/v1/catalog/products?equipmentKind=FURNACE&limit=60').expect(200);
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('filtre par catégorie (inclut le sous-arbre)', async () => {
      const { body } = await get('/v1/catalog/products?category=filtres-4-pouces&limit=60').expect(
        200,
      );
      // 2 tailles × MERV 8/11/13 = 6 produits en 4 pouces.
      expect(body.items).toHaveLength(6);
    });

    it('catégorie inconnue → 404', async () => {
      await get('/v1/catalog/products?category=inexistante').expect(404);
    });
  });

  describe('normalisation des dimensions', () => {
    const writings = [
      '16x25x1',
      '16 x 25 x 1',
      '16-25-1',
      '16*25*1',
      '15 3/4 x 24 3/4 x 3/4',
      '25x16x1',
    ];

    it('toutes les graphies retournent les mêmes produits', async () => {
      const results = await Promise.all(
        writings.map(async (w) => {
          const { body } = await get(
            `/v1/catalog/products?dimension=${encodeURIComponent(w)}`,
          ).expect(200);
          return (body.items as Array<{ id: string }>).map((i) => i.id).sort();
        }),
      );
      const [first, ...rest] = results;
      expect(first).toHaveLength(3);
      for (const other of rest) {
        expect(other).toEqual(first);
      }
    });
  });

  /* ---------------------------- Fiche produit -------------------------- */

  describe('GET /catalog/products/:slug', () => {
    it('retourne la fiche par slug français : variantes, avis, produits liés', async () => {
      const { body } = await get(
        '/v1/catalog/products/filtre-fournaise-boreal-filtration-merv-11-16-25-1?locale=fr',
      ).expect(200);
      expect(body.name).toContain('MERV 11');
      expect(body.brand.slug).toBe('boreal-filtration');
      // Boîtes 1/6/12 → 3 variantes.
      expect(body.variants).toHaveLength(3);
      expect(body.variants[0]).toHaveProperty('actualWidthIn');
      expect(body.equipmentKinds.length).toBeGreaterThan(0);
      // Avis vérifié seedé (5 étoiles) sur ce produit.
      expect(body.reviews.count).toBeGreaterThanOrEqual(1);
      expect(body.reviews.average).toBeGreaterThan(0);
      // Produits liés : autres MERV de la même taille.
      expect(body.related.length).toBeGreaterThan(0);
    });

    it('résout aussi le slug anglais', async () => {
      const { body } = await get(
        '/v1/catalog/products/boreal-filtration-merv-11-furnace-filter-16-25-1?locale=en',
      ).expect(200);
      expect(body.name).toContain('Furnace Filter');
    });

    it('slug inconnu → 404', async () => {
      await get('/v1/catalog/products/nexiste-pas?locale=fr').expect(404);
    });
  });

  /* --------------------------- Index tailles --------------------------- */

  describe('GET /catalog/sizes', () => {
    it('liste les tailles avec compte de produits et MERV', async () => {
      const { body } = await get('/v1/catalog/sizes').expect(200);
      const sizes = body.sizes as Array<{
        label: string;
        productCount: number;
        mervValues: number[];
      }>;
      const size = sizes.find((s) => s.label === '16x25x1');
      expect(size).toBeDefined();
      expect(size!.productCount).toBe(3);
      expect(size!.mervValues).toEqual([8, 11, 13]);
      // 14 tailles distinctes seedées.
      expect(sizes).toHaveLength(14);
    });
  });

  /* ------------------------ Équivalences tailles ----------------------- */

  describe('GET /catalog/sizes/:label/equivalents', () => {
    it('résout les dimensions réelles vers la taille nominale du catalogue', async () => {
      const { body } = await get(
        `/v1/catalog/sizes/${encodeURIComponent('15 3/4 x 24 3/4 x 3/4')}/equivalents`,
      ).expect(200);
      expect(body.catalogLabels).toContain('16x25x1');
      expect(
        body.equivalents.some(
          (e: { label: string; inCatalog: boolean }) => e.label === '16x25x1' && e.inCatalog,
        ),
      ).toBe(true);
    });

    it('dimension invalide → 400', async () => {
      await get('/v1/catalog/sizes/pas-une-taille/equivalents').expect(400);
    });
  });

  /* ------------------------------ Recherche ---------------------------- */

  describe('GET /catalog/search', () => {
    it('tolère les fautes de frappe (« furnance filter »)', async () => {
      const { body } = await get(
        `/v1/catalog/search?locale=en&q=${encodeURIComponent('furnance filter')}`,
      ).expect(200);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].name).toMatch(/Furnace Filter/i);
    });

    it('recherche par SKU', async () => {
      const { body } = await get('/v1/catalog/search?q=BF-16-25-1-M11').expect(200);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].nominalLabels).toContain('16x25x1');
    });

    it('recherche par dimension pure', async () => {
      const { body } = await get('/v1/catalog/search?q=16x25x1').expect(200);
      expect(body.items).toHaveLength(3);
    });

    it('recherche mixte texte + dimension (« 16x25x1 merv 11 »)', async () => {
      const { body } = await get(
        `/v1/catalog/search?q=${encodeURIComponent('16x25x1 merv 11')}`,
      ).expect(200);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].nominalLabels).toContain('16x25x1');
      expect(body.items[0].mervValues).toContain(11);
    });

    it('q vide → 400', async () => {
      await get('/v1/catalog/search?q=').expect(400);
    });
  });

  describe('GET /catalog/search/suggest', () => {
    it('suggère des tailles pour une saisie partielle', async () => {
      const { body } = await get('/v1/catalog/search/suggest?q=16x2').expect(200);
      const labels = (body.sizes as Array<{ label: string }>).map((s) => s.label);
      expect(labels).toEqual(expect.arrayContaining(['16x20x1', '16x25x1']));
    });

    it('suggère des produits par nom de marque', async () => {
      const { body } = await get('/v1/catalog/search/suggest?q=pureflow&locale=fr').expect(200);
      expect(body.products.length).toBeGreaterThan(0);
      expect(body.products[0].name.toLowerCase()).toContain('pureflow');
    });
  });

  /* ------------------------------ Performance -------------------------- */

  describe('performance (seeds)', () => {
    async function p95(path: string, runs: number): Promise<number> {
      const durations: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const start = process.hrtime.bigint();
        await get(path).expect(200);
        durations.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      durations.sort((a, b) => a - b);
      return durations[Math.min(durations.length - 1, Math.floor(runs * 0.95))]!;
    }

    it('liste : p95 < 100 ms', async () => {
      await p95('/v1/catalog/products?limit=24', 5); // préchauffage
      const value = await p95('/v1/catalog/products?limit=24', 30);
      expect(value).toBeLessThan(100);
    });

    it('recherche : p95 < 100 ms', async () => {
      await p95('/v1/catalog/search?q=filtre', 5);
      const value = await p95('/v1/catalog/search?q=filtre', 30);
      expect(value).toBeLessThan(100);
    });

    it('autocomplétion : < 50 ms', async () => {
      await get('/v1/catalog/search/suggest?q=16').expect(200); // préchauffage
      const value = await p95('/v1/catalog/search/suggest?q=16', 30);
      expect(value).toBeLessThan(50);
    });
  });
});
