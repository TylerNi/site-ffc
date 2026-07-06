/**
 * Extraction du catalogue BigCommerce (lecture seule) — tâche 08 §1.
 *
 * `fetchStoreCatalog` interroge une vitrine (produits + variantes + images +
 * champs personnalisés, catégories, marques, pages) et `writeRawExport`
 * sauvegarde le résultat brut en JSON versionné dans `data/raw/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BigCommerceClient } from './client';
import type {
  BigCommerceBrand,
  BigCommerceCategory,
  BigCommercePage,
  BigCommerceProduct,
  CatalogExport,
  StoreCatalog,
  StoreKey,
} from './types';

export interface StoreSource {
  client: BigCommerceClient;
  domain: string;
}

/** Un seul produit — inclut les sous-ressources en une requête (`include`). */
async function fetchProducts(client: BigCommerceClient): Promise<BigCommerceProduct[]> {
  return client.getPaginated<BigCommerceProduct>('/catalog/products', {
    include: 'variants,images,custom_fields',
  });
}

async function fetchCategories(client: BigCommerceClient): Promise<BigCommerceCategory[]> {
  return client.getPaginated<BigCommerceCategory>('/catalog/categories');
}

async function fetchBrands(client: BigCommerceClient): Promise<BigCommerceBrand[]> {
  return client.getPaginated<BigCommerceBrand>('/catalog/brands');
}

async function fetchPages(client: BigCommerceClient): Promise<BigCommercePage[]> {
  return client.getPaginated<BigCommercePage>('/content/pages');
}

export async function fetchStoreCatalog(
  store: StoreKey,
  source: StoreSource,
): Promise<StoreCatalog> {
  const [brands, categories, products, pages] = await Promise.all([
    fetchBrands(source.client),
    fetchCategories(source.client),
    fetchProducts(source.client),
    fetchPages(source.client),
  ]);

  return {
    store,
    domain: source.domain,
    fetchedAt: new Date().toISOString(),
    brands,
    categories,
    products,
    pages,
  };
}

export async function exportCatalog(
  sources: Record<StoreKey, StoreSource>,
): Promise<CatalogExport> {
  const [en, fr] = await Promise.all([
    fetchStoreCatalog('en', sources.en),
    fetchStoreCatalog('fr', sources.fr),
  ]);
  return { fetchedAt: new Date().toISOString(), stores: { en, fr } };
}

/** Écrit l'export dans `data/raw/<horodatage>.json` (jamais écrasé). */
export function writeRawExport(catalogExport: CatalogExport, rawDir: string): { path: string } {
  mkdirSync(rawDir, { recursive: true });
  const stamp = catalogExport.fetchedAt.replace(/[:.]/g, '-');
  const path = join(rawDir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(catalogExport, null, 2), 'utf8');
  return { path };
}
