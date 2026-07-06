/**
 * Import idempotent du catalogue BigCommerce vers la base Prisma — tâche 08.
 *
 * Usage (depuis apps/api) :
 *   pnpm exec tsx --env-file=.env scripts/bigcommerce/import.ts [fichier.json] [--dry-run]
 *
 * Sans argument fichier, prend le dernier export de data/raw/. `--dry-run`
 * exécute tout le chemin de code (donc calcule les vrais comptes créer/mettre
 * à jour) sans écrire en base ni appeler S3.
 *
 * Écrit rapport-import.md et data/urls-bigcommerce.csv à la racine du dépôt.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { buildImportPlan } from '../../src/bigcommerce/transform';
import { importCatalog } from '../../src/bigcommerce/import';
import { S3ImageStore, InMemoryImageStore, type ImageStore } from '../../src/bigcommerce/images';
import { buildDiscrepancyReport } from '../../src/bigcommerce/report';
import { buildUrlRows, buildUrlsCsv } from '../../src/bigcommerce/urls-csv';
import type { CatalogExport } from '../../src/bigcommerce/types';

const repoRoot = join(__dirname, '..', '..', '..', '..');

function resolveInputFile(explicitPath: string | undefined): string {
  if (explicitPath) return explicitPath;
  const rawDir = join(repoRoot, 'data', 'raw');
  const files = readdirSync(rawDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`Aucun export trouvé dans ${rawDir} — lancer d'abord export.ts.`);
  }
  return join(rawDir, latest);
}

function buildImageStore(dryRun: boolean): ImageStore {
  if (dryRun) return new InMemoryImageStore();
  const bucket = process.env.S3_BUCKET_PRODUCT_IMAGES;
  if (!bucket) throw new Error('Variable manquante : S3_BUCKET_PRODUCT_IMAGES');
  return new S3ImageStore({ bucket, region: process.env.AWS_REGION });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inputFile = resolveInputFile(args.find((arg) => !arg.startsWith('--')));

  const catalogExport = JSON.parse(readFileSync(inputFile, 'utf8')) as CatalogExport;
  const { plan, discrepancies, productPairing, categoryPairing } = buildImportPlan(catalogExport);

  const prisma = new PrismaClient();
  try {
    const result = await importCatalog(prisma, plan, {
      dryRun,
      imageStore: buildImageStore(dryRun),
    });

    const reportPath = join(repoRoot, 'rapport-import.md');
    writeFileSync(reportPath, buildDiscrepancyReport(discrepancies, result), 'utf8');

    const csvPath = join(repoRoot, 'data', 'urls-bigcommerce.csv');
    const rows = buildUrlRows(catalogExport, productPairing, categoryPairing);
    writeFileSync(csvPath, buildUrlsCsv(rows), 'utf8');

    console.log(
      `Import ${dryRun ? '(dry-run) ' : ''}terminé :`,
      JSON.stringify(result.counts, null, 2),
    );
    console.log(`Rapport : ${reportPath}`);
    console.log(`URLs : ${csvPath} (${rows.length} lignes)`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
