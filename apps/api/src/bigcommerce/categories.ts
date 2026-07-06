/**
 * Appariement fr ↔ en de l'arborescence de catégories.
 *
 * Les deux vitrines BigCommerce sont des boutiques distinctes : leurs
 * `category_id` ne sont PAS comparables. Hypothèse documentée dans
 * `docs/import-mapping.md` : les deux arborescences ont la même FORME (même
 * nombre de catégories, mêmes positions), seuls les libellés diffèrent selon
 * la langue — on apparie donc par position (tri sur `sort_order` puis `id`)
 * niveau par niveau. Toute catégorie dont la position ne trouve pas
 * d'équivalent dans l'autre vitrine est une « catégorie orpheline » listée
 * au rapport d'écarts plutôt qu'importée à l'aveugle.
 */
import type { BigCommerceCategory } from './types';

export interface CategoryPair {
  en: BigCommerceCategory | null;
  fr: BigCommerceCategory | null;
  /** Chemin de position dans l'arbre (ex. [0, 2] = 3ᵉ enfant du 1ᵉʳ racine). */
  path: number[];
}

export interface CategoryPairingResult {
  pairs: CategoryPair[];
  orphans: { en: BigCommerceCategory[]; fr: BigCommerceCategory[] };
}

function childrenOf(categories: BigCommerceCategory[], parentId: number): BigCommerceCategory[] {
  return categories
    .filter((category) => category.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

export function pairCategoryTrees(
  enCategories: BigCommerceCategory[],
  frCategories: BigCommerceCategory[],
): CategoryPairingResult {
  const pairs: CategoryPair[] = [];
  const orphanEn: BigCommerceCategory[] = [];
  const orphanFr: BigCommerceCategory[] = [];

  function walk(enParentId: number, frParentId: number, path: number[]): void {
    const enChildren = childrenOf(enCategories, enParentId);
    const frChildren = childrenOf(frCategories, frParentId);
    const max = Math.max(enChildren.length, frChildren.length);

    for (let index = 0; index < max; index += 1) {
      const en = enChildren[index] ?? null;
      const fr = frChildren[index] ?? null;
      const childPath = [...path, index];

      if (en && fr) {
        pairs.push({ en, fr, path: childPath });
        walk(en.id, fr.id, childPath);
      } else if (en) {
        orphanEn.push(en);
        for (const descendant of collectDescendants(enCategories, en.id)) orphanEn.push(descendant);
      } else if (fr) {
        orphanFr.push(fr);
        for (const descendant of collectDescendants(frCategories, fr.id)) orphanFr.push(descendant);
      }
    }
  }

  function collectDescendants(
    categories: BigCommerceCategory[],
    parentId: number,
  ): BigCommerceCategory[] {
    const direct = childrenOf(categories, parentId);
    return direct.flatMap((child) => [child, ...collectDescendants(categories, child.id)]);
  }

  walk(0, 0, []);
  return { pairs, orphans: { en: orphanEn, fr: orphanFr } };
}
