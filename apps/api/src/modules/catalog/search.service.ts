import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { extractDimension, type Locale } from '@ffc/core';
import { PrismaService } from '../../database';
import { CatalogService } from './catalog.service';
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
import {
  type CatalogSort,
  type SearchQueryDto,
  type SuggestQueryDto,
} from './dto/catalog-query.dto';
import { type ProductListDto, type SuggestDto } from './dto/catalog-response.dto';

/** Ligne d'une page de résultats de recherche (score inclus). */
interface SearchRow {
  id: string;
  score: number;
  sold_qty: number;
  min_price_cents: number;
}

const DEFAULT_LOCALE: Locale = 'fr';
/** Seuil de similarité en dessous duquel un résultat texte est écarté. */
const SCORE_FLOOR = 0.2;

/**
 * Recherche du catalogue (tâche 06, point 2) : full-text Postgres + trigram
 * pg_trgm, tolérante aux fautes, sur les noms fr/en, les SKU et les
 * dimensions. Une saisie de dimension (toutes graphies) est normalisée puis
 * résolue en tailles équivalentes avant filtrage.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async search(query: SearchQueryDto): Promise<ProductListDto> {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const sort = query.sort ?? 'relevance';
    const limit = clampLimit(query.limit);
    const raw = query.q.trim();

    // Sépare la part « dimension » de la part « texte » (« 16x25x1 merv 11 »).
    let dimension = query.dimension;
    let text = raw;
    if (!dimension) {
      const extracted = extractDimension(raw);
      if (extracted) {
        dimension = extracted.dimension;
        text = extracted.rest;
      }
    }
    text = text.trim();

    // Requête purement dimensionnelle : déléguer à la liste filtrée par taille
    // (même hydratation, mêmes cartes) — le tri « pertinence » y suffit.
    if (dimension && text === '') {
      return this.catalog.listProducts({ ...query, dimension, sort });
    }

    const filters = await this.catalog.resolveFilters({ ...query, dimension });
    const variantWhere = andWhere(filters.variant);
    const productWhere = andWhere(filters.product);
    const dimensionPresent = Boolean(dimension);

    const like = `%${text}%`;
    const prefix = `${text}%`;
    const dimensionBonus = dimensionPresent ? 0.8 : 0;
    // Sans dimension, un produit doit accrocher le texte (nom ou SKU).
    const inclusion = dimensionPresent
      ? Prisma.sql`TRUE`
      : Prisma.sql`(nm.name_score >= ${SCORE_FLOOR} OR sk.sku_score > 0)`;

    const keys = this.searchKeys(sort, query.cursor);
    const keysetWhere = query.cursor ? Prisma.sql`AND ${keysetPredicate(keys)}` : Prisma.empty;
    const inStockWhere = query.inStock ? Prisma.sql`AND t.in_stock = true` : Prisma.empty;
    const scoreFloor = dimensionPresent ? Prisma.empty : Prisma.sql`AND t.score >= ${SCORE_FLOOR}`;
    const orderBy = orderByClause(keys);

    const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      SELECT t.id, t.score, t.sold_qty, t.min_price_cents
      FROM (
        SELECT p.id AS id,
               COALESCE(so.qty, 0) AS sold_qty,
               fv.min_price_cents AS min_price_cents,
               fv.in_stock AS in_stock,
               round(GREATEST(COALESCE(nm.name_score, 0), COALESCE(sk.sku_score, 0), ${dimensionBonus})::numeric, 4)::float8 AS score
        FROM products p
        JOIN (
          SELECT v.product_id AS product_id,
                 MIN(v.price_cents) AS min_price_cents,
                 bool_or(COALESCE(il.quantity_on_hand, 0) - COALESCE(il.quantity_reserved, 0) > 0) AS in_stock
          FROM product_variants v
          LEFT JOIN inventory_levels il ON il.variant_id = v.id
          WHERE v.is_active = true ${variantWhere}
          GROUP BY v.product_id
        ) fv ON fv.product_id = p.id
        LEFT JOIN LATERAL (
          SELECT MAX(GREATEST(
            word_similarity(${text}, pt.name),
            CASE WHEN pt.name ILIKE ${like} THEN 0.85 ELSE 0 END,
            ts_rank(to_tsvector('simple', pt.name), websearch_to_tsquery('simple', ${text}))
          ))::float8 AS name_score
          FROM product_translations pt
          WHERE pt.product_id = p.id
        ) nm ON true
        LEFT JOIN LATERAL (
          SELECT MAX(CASE WHEN v.sku ILIKE ${prefix} THEN 0.95 WHEN v.sku ILIKE ${like} THEN 0.6 ELSE 0 END)::float8 AS sku_score
          FROM product_variants v
          WHERE v.product_id = p.id AND v.is_active = true
        ) sk ON true
        LEFT JOIN (
          SELECT product_id, SUM(quantity)::int AS qty
          FROM order_items WHERE product_id IS NOT NULL GROUP BY product_id
        ) so ON so.product_id = p.id
        WHERE p.status = 'ACTIVE' ${productWhere} AND ${inclusion}
      ) t
      WHERE TRUE ${scoreFloor} ${inStockWhere} ${keysetWhere}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.catalog.hydrateCards(
      pageRows.map((row) => row.id),
      locale,
    );

    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow ? encodeCursor(this.cursorValues(sort, lastRow)) : null;

    return { items, count: items.length, hasMore, nextCursor };
  }

  /** Autocomplétion (< 50 ms) : suggestions de tailles et de produits. */
  async suggest(query: SuggestQueryDto): Promise<SuggestDto> {
    const locale = query.locale ?? DEFAULT_LOCALE;
    const q = query.q.trim();
    const limit = query.limit ?? 6;
    const like = `%${q}%`;
    // Normalise une saisie de taille partielle : « 16 x 2 » → « 16x2 ».
    const sizePrefix = `${q
      .toLowerCase()
      .replace(/\s*(?:x|\*|-|by|par)\s*/gi, 'x')
      .replace(/\s+/g, '')}%`;

    const [sizeRows, productRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ label: string; product_count: number }>>(Prisma.sql`
        SELECT v.nominal_label AS label, COUNT(DISTINCT v.product_id)::int AS product_count
        FROM product_variants v
        JOIN products p ON p.id = v.product_id AND p.status = 'ACTIVE'
        WHERE v.is_active = true AND v.nominal_label ILIKE ${sizePrefix}
        GROUP BY v.nominal_label
        ORDER BY COUNT(DISTINCT v.product_id) DESC, v.nominal_label
        LIMIT ${limit}
      `),
      this.prisma.$queryRaw<
        Array<{ slug: string; name: string; price_from_cents: number; currency: string }>
      >(Prisma.sql`
        SELECT pt.slug AS slug, pt.name AS name,
               MIN(v.price_cents)::int AS price_from_cents,
               MIN(v.currency::text) AS currency
        FROM product_translations pt
        JOIN products p ON p.id = pt.product_id AND p.status = 'ACTIVE'
        JOIN product_variants v ON v.product_id = pt.product_id AND v.is_active = true
        WHERE pt.locale = ${locale}::locale AND (pt.name % ${q} OR pt.name ILIKE ${like})
        GROUP BY pt.product_id, pt.slug, pt.name
        ORDER BY word_similarity(${q}, pt.name) DESC
        LIMIT ${limit}
      `),
    ]);

    return {
      sizes: sizeRows.map((row) => ({ label: row.label, productCount: row.product_count })),
      products: productRows.map((row) => ({
        slug: row.slug,
        name: row.name,
        priceFromCents: row.price_from_cents,
        currency: row.currency === 'USD' ? 'USD' : 'CAD',
      })),
    };
  }

  /* ------------------------------- Keyset ------------------------------ */

  private searchKeys(sort: CatalogSort, cursor?: string): KeysetKey[] {
    const specs = this.searchSortSpecs(sort);
    const values = cursor ? decodeCursor(cursor, specs.length) : undefined;
    return specs.map((spec, index) => ({
      sql: spec.sql,
      direction: spec.direction,
      cast: spec.cast,
      value: values ? values[index]! : 0,
    }));
  }

  private searchSortSpecs(
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
          { sql: Prisma.sql`t.score`, direction: 'DESC' },
          { sql: Prisma.sql`t.sold_qty`, direction: 'DESC' },
          { ...id, direction: 'DESC' },
        ];
    }
  }

  private cursorValues(sort: CatalogSort, row: SearchRow): CursorValue[] {
    switch (sort) {
      case 'price':
        return [row.min_price_cents, row.id];
      case 'popularity':
        return [row.sold_qty, row.id];
      case 'relevance':
      default:
        return [row.score, row.sold_qty, row.id];
    }
  }
}
