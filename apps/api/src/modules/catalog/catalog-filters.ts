import { Prisma } from '@prisma/client';
import { type EquipmentKind } from '@ffc/core';

/**
 * Constructeurs de prédicats SQL partagés par la liste de produits et la
 * recherche. Séparés en deux niveaux :
 *   - VARIANTE : appliqués dans la CTE d'agrégation des variantes (alias `v`)
 *     — un produit n'est retenu que s'il possède UNE variante active
 *     satisfaisant TOUS ces filtres à la fois (dimension + MERV + boîte…).
 *   - PRODUIT : appliqués sur `p` (marque, catégorie, équipement compatible).
 */

/** Filtres au niveau variante déjà résolus (dimension → libellés nominaux). */
export interface VariantFilterInput {
  /** Libellés nominaux à interroger (résolus depuis la dimension). */
  readonly nominalLabels?: readonly string[];
  readonly merv?: number;
  readonly packSize?: number;
  readonly depth?: number;
}

/** Filtres au niveau produit déjà résolus (catégorie → ids du sous-arbre). */
export interface ProductFilterInput {
  readonly brandSlug?: string;
  readonly categoryIds?: readonly string[];
  readonly equipmentKind?: EquipmentKind;
}

/** Prédicats appliqués sur la variante `v` (après `WHERE v.is_active = true`). */
export function variantPredicates(input: VariantFilterInput): Prisma.Sql[] {
  const predicates: Prisma.Sql[] = [];

  if (input.nominalLabels !== undefined) {
    predicates.push(
      input.nominalLabels.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`v.nominal_label IN (${Prisma.join([...input.nominalLabels])})`,
    );
  }
  if (input.merv !== undefined) {
    predicates.push(Prisma.sql`v.merv = ${input.merv}`);
  }
  if (input.packSize !== undefined) {
    predicates.push(Prisma.sql`v.pack_size = ${input.packSize}`);
  }
  if (input.depth !== undefined) {
    predicates.push(Prisma.sql`v.nominal_depth_in = ${input.depth}::numeric`);
  }
  return predicates;
}

/** Prédicats appliqués sur le produit `p`. */
export function productPredicates(input: ProductFilterInput): Prisma.Sql[] {
  const predicates: Prisma.Sql[] = [];

  if (input.brandSlug !== undefined) {
    predicates.push(
      Prisma.sql`EXISTS (SELECT 1 FROM brands b WHERE b.id = p.brand_id AND b.slug = ${input.brandSlug})`,
    );
  }
  if (input.categoryIds !== undefined) {
    predicates.push(
      input.categoryIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`p.category_id IN (${Prisma.join(input.categoryIds.map((id) => Prisma.sql`${id}::uuid`))})`,
    );
  }
  if (input.equipmentKind !== undefined) {
    predicates.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM product_variants pv
        JOIN model_filter_compatibility mfc ON mfc.variant_id = pv.id
        JOIN equipment_models em ON em.id = mfc.equipment_model_id
        WHERE pv.product_id = p.id AND em.kind = ${input.equipmentKind}::equipment_kind)`,
    );
  }
  return predicates;
}
