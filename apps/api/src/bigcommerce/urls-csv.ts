/**
 * Export `data/urls-bigcommerce.csv` (tâche 08 §7) — livrable consommé par la
 * tâche 25 (redirections SEO) : toutes les URLs actuelles des deux vitrines,
 * avec l'identifiant apparié (le même pour les deux locales d'un même
 * produit/catégorie importé, pour reconstruire les paires fr/en).
 */
import type { CategoryPairingResult } from './categories';
import type { PairingResult } from './pairing';
import type { CatalogExport, StoreKey } from './types';

export interface UrlRow {
  domain: string;
  type: 'product' | 'category' | 'page';
  url: string;
  matchedId: string;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildUrlRows(
  catalogExport: CatalogExport,
  productPairing: PairingResult,
  categoryPairing: CategoryPairingResult,
): UrlRow[] {
  const rows: UrlRow[] = [];

  const productMatchedId = new Map<number, string>(); // clé "store:id" -> id apparié
  for (const pair of productPairing.pairs) {
    const canonical = `en:${pair.en.id}`;
    productMatchedId.set(hashKey('en', pair.en.id), canonical);
    productMatchedId.set(hashKey('fr', pair.fr.id), canonical);
  }

  const categoryMatchedId = new Map<number, string>();
  for (const pair of categoryPairing.pairs) {
    const canonical = pair.en ? `en:${pair.en.id}` : `fr:${pair.fr!.id}`;
    if (pair.en) categoryMatchedId.set(hashKey('en', pair.en.id), canonical);
    if (pair.fr) categoryMatchedId.set(hashKey('fr', pair.fr.id), canonical);
  }

  function hashKey(store: StoreKey, id: number): number {
    // Clé numérique simple (store, id) -> entier distinct pour les Map ci-dessus.
    return store === 'en' ? id * 2 : id * 2 + 1;
  }

  for (const store of ['en', 'fr'] as const) {
    const catalog = catalogExport.stores[store];
    for (const product of catalog.products) {
      rows.push({
        domain: catalog.domain,
        type: 'product',
        url: product.custom_url.url,
        matchedId: productMatchedId.get(hashKey(store, product.id)) ?? `${store}:${product.id}`,
      });
    }
    for (const category of catalog.categories) {
      rows.push({
        domain: catalog.domain,
        type: 'category',
        url: category.custom_url.url,
        matchedId: categoryMatchedId.get(hashKey(store, category.id)) ?? `${store}:${category.id}`,
      });
    }
    for (const page of catalog.pages) {
      rows.push({
        domain: catalog.domain,
        type: 'page',
        url: page.url,
        matchedId: `${store}:page:${page.id}`,
      });
    }
  }

  return rows;
}

export function buildUrlsCsv(rows: UrlRow[]): string {
  const header = 'domaine,type,url,identifiant_apparie';
  const lines = rows.map((row) =>
    [row.domain, row.type, row.url, row.matchedId].map(csvEscape).join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}
