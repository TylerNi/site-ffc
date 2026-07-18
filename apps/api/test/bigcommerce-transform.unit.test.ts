import { describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/bigcommerce/transform';
import { buildFixtureCatalogExport } from './fixtures/bigcommerce';

/**
 * Transformation BigCommerce → plan Prisma (tâche 08 §2/§3/§6), fonction
 * PURE — aucun réseau, aucune base. Le fixture couvre chaque cas du brief :
 * paire fr/en par SKU, produit sans équivalent, candidat de revue manuelle,
 * taille non reconnue, SKU en double, catégorie orpheline, produit sans
 * marque/image.
 */
describe('bigcommerce/transform — buildImportPlan', () => {
  const { plan, discrepancies } = buildImportPlan(buildFixtureCatalogExport());

  it('unifie les marques par nom (une seule « ZoneAir » pour les 2 vitrines) + filet « sans marque »', () => {
    expect(plan.brands).toHaveLength(2);
    expect(plan.brands.map((b) => b.key).sort()).toEqual(['', 'zoneair']);
    const zoneair = plan.brands.find((b) => b.key === 'zoneair')!;
    expect(zoneair.bigcommerceBrandId).toBe('en:1'); // EN prioritaire
  });

  it("apparie l'arborescence de catégories par position et isole l'orpheline", () => {
    // racine + « 1 Inch »/« 1 pouce » appariées, « 4 Inch » orpheline.
    expect(plan.categories).toHaveLength(3);
    const root = plan.categories.find((c) => c.bigcommerceCategoryId === 'en:100')!;
    expect(root.translations.map((t) => t.locale).sort()).toEqual(['en', 'fr']);
    const orphan = plan.categories.find((c) => c.bigcommerceCategoryId === 'en:102')!;
    expect(orphan.translations).toHaveLength(1);
    expect(orphan.translations[0]!.locale).toBe('en');
  });

  it('produit A : appariée par SKU, 2 traductions, variante fusionnée', () => {
    const productA = plan.products.find((p) => p.bigcommerceProductId === 'en:301')!;
    expect(productA.translations.map((t) => t.locale).sort()).toEqual(['en', 'fr']);
    expect(productA.translations.find((t) => t.locale === 'fr')!.name).toContain(
      'Filtre de fournaise',
    );
    expect(productA.isFeatured).toBe(true); // vrai côté EN
    expect(productA.variants).toHaveLength(1); // la variante à taille non reconnue est exclue
    const variant = productA.variants[0]!;
    expect(variant.sku).toBe('FF-16x25x1-M11-6');
    expect(variant.nominalLabel).toBe('16x25x1');
    expect(variant.actualDimensions).toEqual({ width: 15.75, height: 24.75, depth: 0.75 });
    expect(variant.merv).toBe(11);
    expect(variant.packSize).toBe(6);
    expect(variant.priceCents).toBe(5999);
    expect(productA.images).toHaveLength(2); // 1 image par vitrine
  });

  it('produit B : sans équivalent → importé en unilingue, signalé au rapport', () => {
    const productB = plan.products.find((p) => p.bigcommerceProductId === 'en:302')!;
    expect(productB.translations).toHaveLength(1);
    expect(productB.brandKey).toBe(''); // aucun brand_id BigCommerce
    expect(discrepancies.productsWithoutTranslation).toContainEqual(
      expect.objectContaining({ store: 'en', id: 302 }),
    );
  });

  it('produit C : candidat de revue manuelle (dimensions + marque, sans SKU commun)', () => {
    // Importé en unilingue des deux côtés, PAS auto-apparié.
    const en = plan.products.find((p) => p.bigcommerceProductId === 'en:303')!;
    const fr = plan.products.find((p) => p.bigcommerceProductId === 'fr:402')!;
    expect(en.translations).toHaveLength(1);
    expect(fr.translations).toHaveLength(1);
    // La catégorie orpheline reste assignable à un produit unilingue.
    expect(en.categoryBigcommerceId).toBe('en:102');

    expect(discrepancies.manualReviewPairs).toHaveLength(1);
    const candidate = discrepancies.manualReviewPairs[0]!;
    expect(candidate.en.id).toBe(303);
    expect(candidate.fr.id).toBe(402);
    expect(candidate.score).toBeGreaterThan(1.5);

    // Ne doit PAS aussi apparaître dans « sans équivalent » (sections distinctes).
    expect(discrepancies.productsWithoutTranslation).not.toContainEqual(
      expect.objectContaining({ id: 303 }),
    );
  });

  it('SKU en double entre deux produits non apparentés : conservé une seule fois', () => {
    const g = plan.products.find((p) => p.bigcommerceProductId === 'en:306')!;
    const h = plan.products.find((p) => p.bigcommerceProductId === 'en:307')!;
    expect(g.variants.map((v) => v.sku)).toEqual(['FF-DUPLICATE-1']);
    expect(h.variants).toHaveLength(0); // retiré : SKU déjà pris par G

    expect(discrepancies.duplicateSkus).toEqual([
      { sku: 'FF-DUPLICATE-1', keptForProduct: 'en:306', ignoredForProducts: ['en:307'] },
    ]);
  });

  it('signale les tailles non reconnues sans les fabriquer', () => {
    expect(discrepancies.variantsWithUnrecognizedDimension).toContainEqual(
      expect.objectContaining({ sku: 'FF-WEIRD-SIZE-EN', raw: '17x99x1' }),
    );
  });

  it('signale les variantes sans dimension repérable (produits à modèle) sans les importer', () => {
    expect(discrepancies.variantsWithoutDimension).toContainEqual(
      expect.objectContaining({ sku: 'FF-MODEL-ONLY-EN' }),
    );
    const h = plan.products.find((p) => p.bigcommerceProductId === 'en:307')!;
    expect(h.variants.map((v) => v.sku)).not.toContain('FF-MODEL-ONLY-EN');
  });

  it('signale les produits sans image (B et H)', () => {
    const ids = discrepancies.productsWithoutImage.map((p) => p.bigcommerceProductId).sort();
    expect(ids).toEqual(['en:302', 'en:307']);
  });

  it('signale la catégorie orpheline EN et aucune orpheline FR', () => {
    expect(discrepancies.orphanCategories.en.map((c) => c.id)).toEqual([102]);
    expect(discrepancies.orphanCategories.fr).toHaveLength(0);
  });

  it('produit exactement 6 fiches produit au total (aucune perte)', () => {
    expect(plan.products).toHaveLength(6);
  });
});
