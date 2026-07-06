/**
 * Génère `rapport-import.md` (tâche 08 §6) : comptes et listes des écarts
 * relevés lors de la transformation/import — sert de todo-list de curation
 * pour l'équipe (traductions manquantes, images manquantes, tailles non
 * reconnues, SKU en double, catégories orphelines, paires à revoir).
 */
import type { DiscrepancyReportData } from './transform';
import type { ImportResult } from './import';

function section(title: string, lines: string[]): string {
  if (lines.length === 0) {
    return `## ${title}\n\nAucun écart. ✔️\n`;
  }
  return `## ${title} (${lines.length})\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

export function buildDiscrepancyReport(
  discrepancies: DiscrepancyReportData,
  importResult?: ImportResult,
): string {
  const generatedAt = new Date().toISOString();

  const parts: string[] = [
    "# Rapport d'écarts — import du catalogue BigCommerce (tâche 08)",
    '',
    `Généré le ${generatedAt}. Document GÉNÉRÉ par \`scripts/bigcommerce/import.ts\` — ne pas éditer à la main.`,
    '',
  ];

  if (importResult) {
    parts.push(
      "## Résultat de l'import",
      '',
      `- Mode : ${importResult.dryRun ? '**dry-run** (aucune écriture)' : 'réel'}`,
      `- Marques : ${importResult.counts.brandsCreated} créées, ${importResult.counts.brandsUpdated} mises à jour`,
      `- Catégories : ${importResult.counts.categoriesCreated} créées, ${importResult.counts.categoriesUpdated} mises à jour`,
      `- Produits : ${importResult.counts.productsCreated} créés, ${importResult.counts.productsUpdated} mis à jour`,
      `- Variantes : ${importResult.counts.variantsCreated} créées, ${importResult.counts.variantsUpdated} mises à jour`,
      `- Images traitées : ${importResult.counts.imagesUpserted}`,
      '',
    );
  }

  parts.push(
    section(
      "Produits sans équivalent dans l'autre langue",
      discrepancies.productsWithoutTranslation.map(
        (p) => `[${p.store}] #${p.id} « ${p.name} » — ${p.url}`,
      ),
    ),
    '',
    section(
      'Paires candidates à revue manuelle (dimensions/marque/nom proches)',
      discrepancies.manualReviewPairs.map(
        (c) =>
          `en #${c.en.id} « ${c.en.name} » ↔ fr #${c.fr.id} « ${c.fr.name} » — score ${c.score.toFixed(2)} (${c.reasons.join('; ')})`,
      ),
    ),
    '',
    section(
      'Produits sans image',
      discrepancies.productsWithoutImage.map((p) => `${p.bigcommerceProductId} — « ${p.name} »`),
    ),
    '',
    section(
      'Variantes sans dimension reconnue (référentiel @ffc/core)',
      discrepancies.variantsWithUnrecognizedDimension.map(
        (v) => `SKU ${v.sku} — « ${v.productName} » — taille brute lue : « ${v.raw} »`,
      ),
    ),
    '',
    section(
      'SKU en double (conservés pour un seul produit)',
      discrepancies.duplicateSkus.map(
        (d) =>
          `SKU ${d.sku} — conservé pour ${d.keptForProduct}, ignoré pour ${d.ignoredForProducts.join(', ')}`,
      ),
    ),
    '',
    section(
      'Catégories orphelines (EN)',
      discrepancies.orphanCategories.en.map((c) => `#${c.id} « ${c.name} » — ${c.custom_url.url}`),
    ),
    '',
    section(
      'Catégories orphelines (FR)',
      discrepancies.orphanCategories.fr.map((c) => `#${c.id} « ${c.name} » — ${c.custom_url.url}`),
    ),
    '',
  );

  return parts.join('\n');
}
