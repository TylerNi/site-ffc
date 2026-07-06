/**
 * Extraction du catalogue BigCommerce des deux vitrines — tâche 08.
 *
 * Usage (depuis apps/api, jetons dans .env — voir .env.example) :
 *   pnpm exec tsx --env-file=.env scripts/bigcommerce/export.ts
 *
 * Écrit un instantané horodaté dans data/raw/ (jamais écrasé). Lecture
 * seule : n'écrit jamais sur les vitrines BigCommerce elles-mêmes.
 */
import { join } from 'node:path';
import { bigCommerceClientFromEnv } from '../../src/bigcommerce/client';
import { exportCatalog, writeRawExport } from '../../src/bigcommerce/export';

async function main(): Promise<void> {
  const domainEn = process.env.BIGCOMMERCE_DOMAIN_EN ?? 'furnacefilterscanada.com';
  const domainFr = process.env.BIGCOMMERCE_DOMAIN_FR ?? 'filtrationmontreal.com';

  const catalogExport = await exportCatalog({
    en: { client: bigCommerceClientFromEnv('en'), domain: domainEn },
    fr: { client: bigCommerceClientFromEnv('fr'), domain: domainFr },
  });

  const rawDir = join(__dirname, '..', '..', '..', '..', 'data', 'raw');
  const { path } = writeRawExport(catalogExport, rawDir);

  console.log(`Export écrit : ${path}`);
  for (const store of ['en', 'fr'] as const) {
    const catalog = catalogExport.stores[store];
    console.log(
      `  [${store}] ${catalog.domain} — ${catalog.products.length} produits, ` +
        `${catalog.categories.length} catégories, ${catalog.brands.length} marques, ${catalog.pages.length} pages`,
    );
  }
}

void main();
