import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { PrismaService } from '../../database';
import { productPredicates, variantPredicates } from './catalog-filters';
import {
  andWhere,
  clampLimit,
  type CursorValue,
  decodeCursor,
  encodeCursor,
  type KeysetKey,
  keysetPredicate,
  orderByClause,
} from './catalog.util';
import { type CatalogFilterQueryDto, type CatalogSort } from './dto/catalog-query.dto';
import {
  type CategoryNodeDto,
  type CategoryTreeDto,
  type LocalizedSlugsDto,
  type ProductDetailDto,
  type ProductImageDto,
  type ProductListDto,
  type ProductListItemDto,
  type SitemapDto,
  type SizeIndexDto,
  type VariantDto,
} from './dto/catalog-response.dto';
import { SizeService } from './size.service';

/** Ligne d'une page de produits renvoyée par la requête keyset brute. */
interface ProductPageRow {
  id: string;
  min_price_cents: number;
  max_price_cents: number;
  in_stock: boolean;
  sold_qty: number;
  is_featured: boolean;
}

/** Prédicats de filtre résolus (dimension → libellés, catégorie → ids). */
interface ResolvedFilters {
  variant: Prisma.Sql[];
  product: Prisma.Sql[];
}

const DEFAULT_LOCALE: Locale = 'fr';

/**
 * Catalogue public (tâche 06) : arbre de catégories, liste filtrable et
 * paginée par curseur, fiche produit par slug localisé, index des tailles.
 *
 * Anti N+1 : la liste passe par UNE requête keyset (ids + agrégats) puis UNE
 * hydratation groupée (`findMany … in ids`). Aucune boucle de requêtes.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly size: SizeService,
  ) {}

  /* ----------------------------- Catégories ---------------------------- */

  async getCategoryTree(locale: Locale = DEFAULT_LOCALE): Promise<CategoryTreeDto> {
    const [categories, grouped] = await Promise.all([
      this.prisma.category.findMany({
        where: { isActive: true },
        include: { translations: { where: { locale } } },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.product.groupBy({
        by: ['categoryId'],
        where: { status: 'ACTIVE', categoryId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const directCounts = new Map<string, number>();
    for (const row of grouped) {
      if (row.categoryId) directCounts.set(row.categoryId, row._count._all);
    }

    // Index parent → enfants pour construire l'arbre en une passe.
    const childrenByParent = new Map<string | null, typeof categories>();
    for (const category of categories) {
      const key = category.parentId;
      const list = childrenByParent.get(key) ?? [];
      list.push(category);
      childrenByParent.set(key, list);
    }

    const build = (parentId: string | null): CategoryNodeDto[] =>
      (childrenByParent.get(parentId) ?? []).map((category) => {
        const children = build(category.id);
        const translation = category.translations[0];
        const subtreeCount =
          (directCounts.get(category.id) ?? 0) +
          children.reduce((sum, child) => sum + child.productCount, 0);
        return {
          id: category.id,
          slug: translation?.slug ?? '',
          name: translation?.name ?? '',
          description: translation?.description ?? null,
          productCount: subtreeCount,
          children,
        };
      });

    return { categories: build(null) };
  }

  /* --------------------------- Liste produits -------------------------- */

  async listProducts(query: CatalogFilterQueryDto): Promise<ProductListDto> {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const sort = query.sort ?? 'relevance';
    const limit = clampLimit(query.limit);
    const filters = await this.resolveFilters(query);

    const rows = await this.fetchProductPage({
      filters,
      sort,
      cursor: query.cursor,
      limit,
      inStock: query.inStock,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.hydrateCards(
      pageRows.map((row) => row.id),
      locale,
    );

    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow ? encodeCursor(this.cursorValues(sort, lastRow)) : null;

    return { items, count: items.length, hasMore, nextCursor };
  }

  /**
   * Requête de page : sous-requête agrégée (prix min/max, stock, ventes) puis
   * keyset stable + tri. Partagée en interne; la recherche a sa propre requête
   * scorée (SearchService). Exposée pour réutilisation par SearchService.
   */
  async fetchProductPage(params: {
    filters: ResolvedFilters;
    sort: CatalogSort;
    cursor?: string;
    limit: number;
    inStock?: boolean;
  }): Promise<ProductPageRow[]> {
    const { filters, sort, cursor, limit, inStock } = params;
    const variantWhere = andWhere(filters.variant);
    const productWhere = andWhere(filters.product);
    const inStockWhere = inStock ? Prisma.sql`AND t.in_stock = true` : Prisma.empty;

    const keys = this.keysetKeys(sort, cursor);
    const keysetWhere = cursor ? Prisma.sql`AND ${keysetPredicate(keys)}` : Prisma.empty;
    const orderBy = orderByClause(keys);

    return this.prisma.$queryRaw<ProductPageRow[]>(Prisma.sql`
      SELECT t.id, t.min_price_cents, t.max_price_cents, t.in_stock, t.sold_qty, t.is_featured
      FROM (
        SELECT p.id AS id,
               fv.min_price_cents AS min_price_cents,
               fv.max_price_cents AS max_price_cents,
               fv.in_stock AS in_stock,
               COALESCE(so.qty, 0) AS sold_qty,
               p.is_featured AS is_featured
        FROM products p
        JOIN (
          SELECT v.product_id AS product_id,
                 MIN(v.price_cents) AS min_price_cents,
                 MAX(v.price_cents) AS max_price_cents,
                 bool_or(COALESCE(il.quantity_on_hand, 0) - COALESCE(il.quantity_reserved, 0) > 0) AS in_stock
          FROM product_variants v
          LEFT JOIN inventory_levels il ON il.variant_id = v.id
          WHERE v.is_active = true ${variantWhere}
          GROUP BY v.product_id
        ) fv ON fv.product_id = p.id
        LEFT JOIN (
          SELECT product_id, SUM(quantity)::int AS qty
          FROM order_items WHERE product_id IS NOT NULL GROUP BY product_id
        ) so ON so.product_id = p.id
        WHERE p.status = 'ACTIVE' ${productWhere}
      ) t
      WHERE TRUE ${inStockWhere} ${keysetWhere}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `);
  }

  /** Clés keyset (expr + direction + valeur du curseur) selon le tri. */
  private keysetKeys(sort: CatalogSort, cursor?: string): KeysetKey[] {
    const specs = this.sortSpecs(sort);
    const values = cursor ? decodeCursor(cursor, specs.length) : undefined;
    return specs.map((spec, index) => ({
      sql: spec.sql,
      direction: spec.direction,
      cast: spec.cast,
      value: values ? values[index]! : 0,
    }));
  }

  /** Colonnes de tri (alias de la sous-requête `t`) et directions par tri. */
  private sortSpecs(
    sort: CatalogSort,
  ): Array<{ sql: Prisma.Sql; direction: 'ASC' | 'DESC'; cast?: 'uuid' }> {
    const id = { sql: Prisma.sql`t.id`, cast: 'uuid' as const };
    switch (sort) {
      case 'price':
        return [
          { sql: Prisma.sql`t.min_price_cents`, direction: 'ASC' },
          { ...id, direction: 'ASC' },
        ];
      case 'popularity':
        return [
          { sql: Prisma.sql`t.sold_qty`, direction: 'DESC' },
          { ...id, direction: 'DESC' },
        ];
      case 'relevance':
      default:
        return [
          { sql: Prisma.sql`t.is_featured`, direction: 'DESC' },
          { sql: Prisma.sql`t.sold_qty`, direction: 'DESC' },
          { ...id, direction: 'DESC' },
        ];
    }
  }

  /** Valeurs à encoder dans le curseur pour la dernière ligne de la page. */
  private cursorValues(sort: CatalogSort, row: ProductPageRow): CursorValue[] {
    switch (sort) {
      case 'price':
        return [row.min_price_cents, row.id];
      case 'popularity':
        return [row.sold_qty, row.id];
      case 'relevance':
      default:
        return [row.is_featured, row.sold_qty, row.id];
    }
  }

  /**
   * Hydrate des cartes produits à partir d'ids, dans l'ordre fourni (celui du
   * keyset ou du score). UNE requête groupée — partagé par liste et recherche.
   */
  async hydrateCards(orderedIds: string[], locale: Locale): Promise<ProductListItemDto[]> {
    if (orderedIds.length === 0) return [];
    const products = await this.prisma.product.findMany({
      where: { id: { in: orderedIds } },
      include: {
        brand: true,
        translations: true,
        images: { orderBy: { position: 'asc' }, take: 1 },
        variants: {
          where: { isActive: true },
          include: { inventoryLevel: true },
          orderBy: { priceCents: 'asc' },
        },
      },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return orderedIds.flatMap((id) => {
      const product = byId.get(id);
      if (!product) return [];
      const translation = pickTranslation(product.translations, locale);
      const variants = product.variants;
      const prices = variants.map((v) => v.priceCents);
      const image = product.images[0];

      return [
        {
          id: product.id,
          slug: translation?.slug ?? '',
          name: translation?.name ?? '',
          shortDescription: translation?.shortDescription ?? null,
          brand: { slug: product.brand.slug, name: product.brand.name },
          priceFromCents: prices.length ? Math.min(...prices) : 0,
          priceToCents: prices.length ? Math.max(...prices) : 0,
          currency: variants[0]?.currency ?? 'CAD',
          inStock: variants.some((v) => availableQty(v.inventoryLevel) > 0),
          nominalLabels: unique(variants.map((v) => v.nominalLabel)),
          mervValues: unique(
            variants.map((v) => v.merv).filter((m): m is number => m !== null),
          ).sort((a, b) => a - b),
          packSizes: unique(variants.map((v) => v.packSize)).sort((a, b) => a - b),
          isFeatured: product.isFeatured,
          image: image ? this.toImageDto(image, locale) : null,
        },
      ];
    });
  }

  /* ---------------------------- Fiche produit -------------------------- */

  async getProductBySlug(slug: string, locale: Locale = DEFAULT_LOCALE): Promise<ProductDetailDto> {
    const match = await this.prisma.productTranslation.findFirst({
      where: { slug, locale, product: { status: 'ACTIVE' } },
      select: { productId: true },
    });
    if (!match) {
      throw new NotFoundException(`Produit « ${slug} » introuvable (${locale}).`);
    }

    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: match.productId },
      include: {
        brand: true,
        translations: true,
        category: { include: { translations: { where: { locale } } } },
        images: { orderBy: { position: 'asc' } },
        variants: {
          where: { isActive: true },
          include: { inventoryLevel: true },
          orderBy: [{ nominalDepthIn: 'asc' }, { merv: 'asc' }, { packSize: 'asc' }],
        },
        reviews: { where: { status: 'APPROVED' }, select: { rating: true } },
      },
    });

    const translation = pickTranslation(product.translations, locale);
    const nominalLabels = unique(product.variants.map((v) => v.nominalLabel));

    const [equipmentKinds, related] = await Promise.all([
      this.equipmentKindsFor(product.id),
      this.relatedProducts(product.id, nominalLabels, locale),
    ]);

    const ratings = product.reviews.map((r) => r.rating);
    const average = ratings.length
      ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10
      : 0;

    const categoryTranslation = product.category?.translations[0];

    return {
      id: product.id,
      slug: translation?.slug ?? slug,
      slugs: localizedSlugs(product.translations),
      name: translation?.name ?? '',
      shortDescription: translation?.shortDescription ?? null,
      description: translation?.description ?? null,
      metaTitle: translation?.metaTitle ?? null,
      metaDescription: translation?.metaDescription ?? null,
      brand: { slug: product.brand.slug, name: product.brand.name },
      category: categoryTranslation
        ? { slug: categoryTranslation.slug, name: categoryTranslation.name }
        : null,
      equipmentKinds,
      variants: product.variants.map((v) => this.toVariantDto(v)),
      images: product.images.map((image) => this.toImageDto(image, locale)),
      reviews: { average, count: ratings.length },
      related,
    };
  }

  private async equipmentKindsFor(productId: string): Promise<ProductDetailDto['equipmentKinds']> {
    const rows = await this.prisma.$queryRaw<
      Array<{ kind: ProductDetailDto['equipmentKinds'][number] }>
    >`
      SELECT DISTINCT em.kind
      FROM equipment_models em
      JOIN model_filter_compatibility mfc ON mfc.equipment_model_id = em.id
      JOIN product_variants v ON v.id = mfc.variant_id
      WHERE v.product_id = ${productId}::uuid`;
    return rows.map((row) => row.kind);
  }

  private async relatedProducts(
    productId: string,
    nominalLabels: string[],
    locale: Locale,
  ): Promise<ProductDetailDto['related']> {
    if (nominalLabels.length === 0) return [];
    const products = await this.prisma.product.findMany({
      where: {
        id: { not: productId },
        status: 'ACTIVE',
        variants: { some: { isActive: true, nominalLabel: { in: nominalLabels } } },
      },
      include: {
        translations: { where: { locale } },
        variants: {
          where: { isActive: true },
          select: { priceCents: true, currency: true, merv: true },
        },
      },
      take: 8,
    });

    return products.flatMap((product) => {
      const translation = product.translations[0];
      if (!translation) return [];
      const prices = product.variants.map((v) => v.priceCents);
      const mervs = product.variants.map((v) => v.merv).filter((m): m is number => m !== null);
      return [
        {
          id: product.id,
          slug: translation.slug,
          name: translation.name,
          priceFromCents: prices.length ? Math.min(...prices) : 0,
          currency: product.variants[0]?.currency ?? 'CAD',
          merv: mervs.length ? Math.min(...mervs) : null,
          relation: 'size',
        },
      ];
    });
  }

  /* --------------------------- Index tailles --------------------------- */

  async getSizeIndex(): Promise<SizeIndexDto> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        label: string;
        width: number;
        height: number;
        depth: number;
        product_count: number;
        merv_values: number[] | null;
      }>
    >`
      SELECT v.nominal_label AS label,
             MIN(v.nominal_width_in)::float AS width,
             MIN(v.nominal_height_in)::float AS height,
             MIN(v.nominal_depth_in)::float AS depth,
             COUNT(DISTINCT v.product_id)::int AS product_count,
             array_remove(array_agg(DISTINCT v.merv ORDER BY v.merv), NULL) AS merv_values
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.status = 'ACTIVE'
      WHERE v.is_active = true
      GROUP BY v.nominal_label
      ORDER BY MIN(v.nominal_depth_in), MIN(v.nominal_width_in), MIN(v.nominal_height_in)`;

    return {
      sizes: rows.map((row) => ({
        label: row.label,
        width: row.width,
        height: row.height,
        depth: row.depth,
        productCount: row.product_count,
        mervValues: row.merv_values ?? [],
      })),
    };
  }

  /* -------------------------------- Sitemap ----------------------------- */

  /**
   * Matière première des sitemaps de la vitrine (tâche 07) : tous les
   * produits/catégories actifs avec leurs slugs fr ET en (alternates
   * hreflang), plus les libellés de tailles. Volume : un enregistrement léger
   * par URL — pas de pagination tant que le catalogue reste < ~10 000 produits.
   */
  async getSitemap(): Promise<SitemapDto> {
    const [products, categories, sizeIndex] = await Promise.all([
      this.prisma.product.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          updatedAt: true,
          translations: { select: { locale: true, slug: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.category.findMany({
        where: { isActive: true },
        select: { translations: { select: { locale: true, slug: true } } },
        orderBy: { sortOrder: 'asc' },
      }),
      this.getSizeIndex(),
    ]);

    return {
      products: products.map((product) => ({
        id: product.id,
        slugs: localizedSlugs(product.translations),
        updatedAt: product.updatedAt.toISOString(),
      })),
      categories: categories.map((category) => ({
        slugs: localizedSlugs(category.translations),
      })),
      sizes: sizeIndex.sizes.map((size) => size.label),
    };
  }

  /* ------------------------------ Filtres ------------------------------ */

  /** Résout les filtres de requête en prédicats SQL (partagé avec la recherche). */
  async resolveFilters(query: CatalogFilterQueryDto): Promise<ResolvedFilters> {
    const categoryIds =
      query.category !== undefined
        ? await this.resolveCategorySubtree(query.category, query.locale ?? DEFAULT_LOCALE)
        : undefined;

    const variant = variantPredicates({
      nominalLabels:
        query.dimension !== undefined ? this.size.resolve(query.dimension).labels : undefined,
      merv: query.merv,
      packSize: query.packSize,
      depth: query.depth,
    });
    const product = productPredicates({
      brandSlug: query.brand,
      equipmentKind: query.equipmentKind,
      categoryIds,
    });

    return { variant, product };
  }

  /** Résout un slug de catégorie (localisé) en ids de son sous-arbre. */
  private async resolveCategorySubtree(slug: string, locale: Locale): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE root AS (
        SELECT c.id
        FROM categories c
        JOIN category_translations ct ON ct.category_id = c.id
        WHERE ct.locale = ${locale}::locale AND ct.slug = ${slug} AND c.is_active = true
      ),
      subtree AS (
        SELECT id FROM root
        UNION ALL
        SELECT c.id FROM categories c
        JOIN subtree s ON c.parent_id = s.id
        WHERE c.is_active = true
      )
      SELECT id FROM subtree`;
    if (rows.length === 0) {
      throw new NotFoundException(`Catégorie « ${slug} » introuvable (${locale}).`);
    }
    return rows.map((row) => row.id);
  }

  /* ------------------------------ Mappers ------------------------------ */

  private toImageDto(
    image: {
      url: string;
      altFr: string | null;
      altEn: string | null;
      width: number | null;
      height: number | null;
    },
    locale: Locale,
  ): ProductImageDto {
    return {
      url: image.url,
      alt: locale === 'fr' ? image.altFr : image.altEn,
      width: image.width,
      height: image.height,
    };
  }

  private toVariantDto(variant: {
    id: string;
    sku: string;
    nominalLabel: string;
    nominalWidthIn: Prisma.Decimal;
    nominalHeightIn: Prisma.Decimal;
    nominalDepthIn: Prisma.Decimal;
    actualWidthIn: Prisma.Decimal;
    actualHeightIn: Prisma.Decimal;
    actualDepthIn: Prisma.Decimal;
    merv: number | null;
    packSize: number;
    priceCents: number;
    compareAtPriceCents: number | null;
    currency: VariantDto['currency'];
    inventoryLevel: { quantityOnHand: number; quantityReserved: number } | null;
  }): VariantDto {
    const available = availableQty(variant.inventoryLevel);
    return {
      id: variant.id,
      sku: variant.sku,
      nominalLabel: variant.nominalLabel,
      nominalWidthIn: Number(variant.nominalWidthIn),
      nominalHeightIn: Number(variant.nominalHeightIn),
      nominalDepthIn: Number(variant.nominalDepthIn),
      actualWidthIn: Number(variant.actualWidthIn),
      actualHeightIn: Number(variant.actualHeightIn),
      actualDepthIn: Number(variant.actualDepthIn),
      merv: variant.merv,
      packSize: variant.packSize,
      priceCents: variant.priceCents,
      compareAtPriceCents: variant.compareAtPriceCents,
      currency: variant.currency,
      availableQuantity: Math.max(available, 0),
      inStock: available > 0,
    };
  }
}

/* ------------------------------- Utilitaires ------------------------------ */

function pickTranslation<T extends { locale: Locale }>(
  translations: T[],
  locale: Locale,
): T | undefined {
  return translations.find((t) => t.locale === locale) ?? translations[0];
}

/** Slugs par locale (null si la traduction manque) — hreflang et sitemaps. */
function localizedSlugs(translations: Array<{ locale: Locale; slug: string }>): LocalizedSlugsDto {
  return {
    fr: translations.find((t) => t.locale === 'fr')?.slug ?? null,
    en: translations.find((t) => t.locale === 'en')?.slug ?? null,
  };
}

function availableQty(level: { quantityOnHand: number; quantityReserved: number } | null): number {
  if (!level) return 0;
  return level.quantityOnHand - level.quantityReserved;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
