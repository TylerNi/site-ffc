import { describe, expect, it } from 'vitest';
import { buildDiscrepancyReport } from '../src/bigcommerce/report';
import { buildImportPlan } from '../src/bigcommerce/transform';
import { buildUrlRows, buildUrlsCsv } from '../src/bigcommerce/urls-csv';
import { buildFixtureCatalogExport } from './fixtures/bigcommerce';

/**
 * Livrables générés (tâche 08 §6/§7) : rapport-import.md et
 * data/urls-bigcommerce.csv. On vérifie la FORME (sections, en-têtes,
 * cohérence des identifiants appariés), pas le rendu exact.
 */
describe('bigcommerce/report + urls-csv', () => {
  const catalogExport = buildFixtureCatalogExport();
  const { discrepancies, productPairing, categoryPairing } = buildImportPlan(catalogExport);

  it('buildDiscrepancyReport liste chaque section attendue', () => {
    const report = buildDiscrepancyReport(discrepancies);
    expect(report).toContain("Produits sans équivalent dans l'autre langue");
    expect(report).toContain('Paires candidates à revue manuelle');
    expect(report).toContain('Produits sans image');
    expect(report).toContain('Variantes sans dimension reconnue');
    expect(report).toContain('Variantes sans dimension repérable');
    expect(report).toContain('FF-MODEL-ONLY-EN');
    expect(report).toContain('SKU en double');
    expect(report).toContain('Catégories orphelines (EN)');
    expect(report).toContain('FF-DUPLICATE-1');
    expect(report).toContain('17x99x1');
  });

  it("inclut le résultat d'import quand fourni", () => {
    const report = buildDiscrepancyReport(discrepancies, {
      dryRun: true,
      counts: {
        brandsCreated: 1,
        brandsUpdated: 0,
        categoriesCreated: 1,
        categoriesUpdated: 0,
        productsCreated: 6,
        productsUpdated: 0,
        variantsCreated: 4,
        variantsUpdated: 0,
        imagesUpserted: 4,
      },
    });
    expect(report).toContain('dry-run');
    expect(report).toContain('6 créés');
  });

  it("buildUrlRows apparie le même identifiant pour les deux locales d'une paire produit", () => {
    const rows = buildUrlRows(catalogExport, productPairing, categoryPairing);
    const productRows = rows.filter((r) => r.type === 'product');
    const enA = productRows.find((r) => r.url === '/16x25x1-merv-11-furnace-filter/')!;
    const frA = productRows.find((r) => r.url === '/filtre-fournaise-16x25x1-merv-11/')!;
    expect(enA.matchedId).toBe(frA.matchedId);
    expect(enA.matchedId).toBe('en:301');
  });

  it('buildUrlsCsv produit un CSV valide avec en-tête', () => {
    const rows = buildUrlRows(catalogExport, productPairing, categoryPairing);
    const csv = buildUrlsCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('domaine,type,url,identifiant_apparie');
    expect(lines.length).toBe(rows.length + 1);
  });
});
