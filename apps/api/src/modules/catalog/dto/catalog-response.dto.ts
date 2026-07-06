import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CURRENCIES, type Currency, EQUIPMENT_KINDS, type EquipmentKind } from '@ffc/core';

/* ------------------------------- Catégories ------------------------------ */

export class CategoryNodeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'filtres-1-pouce' })
  slug!: string;

  @ApiProperty({ example: 'Filtres 1 pouce' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description?: string | null;

  @ApiProperty({ description: 'Produits actifs dans cette catégorie et ses sous-catégories' })
  productCount!: number;

  @ApiProperty({ type: () => [CategoryNodeDto] })
  children!: CategoryNodeDto[];
}

export class CategoryTreeDto {
  @ApiProperty({ type: [CategoryNodeDto] })
  categories!: CategoryNodeDto[];
}

/* --------------------------------- Images -------------------------------- */

export class ProductImageDto {
  @ApiProperty({ description: 'Clé S3 ou URL CDN' })
  url!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  alt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  width?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  height?: number | null;
}

/* -------------------------------- Marques -------------------------------- */

export class BrandRefDto {
  @ApiProperty({ example: 'boreal-filtration' })
  slug!: string;

  @ApiProperty({ example: 'Boréal Filtration' })
  name!: string;
}

/** Référence de catégorie localisée (fiche produit). */
export class CategoryRefDto {
  @ApiProperty({ example: 'filtres-1-pouce' })
  slug!: string;

  @ApiProperty({ example: 'Filtres 1 pouce' })
  name!: string;
}

/** Dimensions en pouces (largeur × hauteur × profondeur). */
export class DimensionsDto {
  @ApiProperty({ example: 16 })
  width!: number;

  @ApiProperty({ example: 25 })
  height!: number;

  @ApiProperty({ example: 1 })
  depth!: number;
}

/* --------------------------- Liste de produits --------------------------- */

/** Carte produit pour les grilles de catalogue. */
export class ProductListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Slug localisé de la fiche produit' })
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  shortDescription?: string | null;

  @ApiProperty({ type: BrandRefDto })
  brand!: BrandRefDto;

  @ApiProperty({ description: 'Prix le plus bas (cents)' })
  priceFromCents!: number;

  @ApiProperty({ description: 'Prix le plus haut (cents)' })
  priceToCents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty({ description: 'Au moins une variante disponible' })
  inStock!: boolean;

  @ApiProperty({ type: [String], description: 'Tailles nominales offertes (ex. « 16x25x1 »)' })
  nominalLabels!: string[];

  @ApiProperty({ type: [Number], description: 'Cotes MERV offertes' })
  mervValues!: number[];

  @ApiProperty({ type: [Number], description: 'Formats de boîte offerts' })
  packSizes!: number[];

  @ApiProperty()
  isFeatured!: boolean;

  @ApiPropertyOptional({ type: ProductImageDto, nullable: true })
  image?: ProductImageDto | null;
}

export class ProductListDto {
  @ApiProperty({ type: [ProductListItemDto] })
  items!: ProductListItemDto[];

  @ApiProperty({ description: 'Nombre d’items retournés' })
  count!: number;

  @ApiProperty({ description: 'Autres pages disponibles' })
  hasMore!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'À passer en ?cursor= pour la page suivante',
  })
  nextCursor?: string | null;
}

/* ----------------------------- Fiche produit ----------------------------- */

export class VariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ example: '16x25x1' })
  nominalLabel!: string;

  @ApiProperty({ description: 'Dimensions nominales/réelles en pouces' })
  nominalWidthIn!: number;

  @ApiProperty()
  nominalHeightIn!: number;

  @ApiProperty()
  nominalDepthIn!: number;

  @ApiProperty()
  actualWidthIn!: number;

  @ApiProperty()
  actualHeightIn!: number;

  @ApiProperty()
  actualDepthIn!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  merv?: number | null;

  @ApiProperty()
  packSize!: number;

  @ApiProperty()
  priceCents!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  compareAtPriceCents?: number | null;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty({ description: 'Quantité disponible (en main − réservée)' })
  availableQuantity!: number;

  @ApiProperty()
  inStock!: boolean;
}

/** Produit lié (autre format de boîte, autre MERV de la même taille). */
export class RelatedProductDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  priceFromCents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiPropertyOptional({ nullable: true, type: Number })
  merv?: number | null;

  @ApiProperty({ description: 'Relation : « size » (même taille), « pack » (autre format)' })
  relation!: string;
}

export class ReviewSummaryDto {
  @ApiProperty({ description: 'Note moyenne (0 si aucun avis)', example: 4.7 })
  average!: number;

  @ApiProperty({ description: 'Nombre d’avis approuvés' })
  count!: number;
}

/**
 * Slugs de la même ressource dans chaque locale — nécessaires aux liens
 * hreflang et aux alternates de sitemap de la vitrine (tâche 07). Null si la
 * traduction manque dans cette locale.
 */
export class LocalizedSlugsDto {
  @ApiPropertyOptional({ nullable: true, type: String, example: 'filtre-16x25x1-merv-11' })
  fr?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'filter-16x25x1-merv-11' })
  en?: string | null;
}

export class ProductDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: LocalizedSlugsDto, description: 'Slugs fr/en (hreflang, sitemap)' })
  slugs!: LocalizedSlugsDto;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  shortDescription?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  metaTitle?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  metaDescription?: string | null;

  @ApiProperty({ type: BrandRefDto })
  brand!: BrandRefDto;

  @ApiPropertyOptional({ type: CategoryRefDto, nullable: true })
  category?: CategoryRefDto | null;

  @ApiProperty({
    enum: EQUIPMENT_KINDS,
    isArray: true,
    description: 'Types d’équipement compatibles',
  })
  equipmentKinds!: EquipmentKind[];

  @ApiProperty({ type: [VariantDto] })
  variants!: VariantDto[];

  @ApiProperty({ type: [ProductImageDto] })
  images!: ProductImageDto[];

  @ApiProperty({ type: ReviewSummaryDto })
  reviews!: ReviewSummaryDto;

  @ApiProperty({ type: [RelatedProductDto] })
  related!: RelatedProductDto[];
}

/* --------------------------- Index des tailles --------------------------- */

export class SizeIndexItemDto {
  @ApiProperty({ example: '16x25x1' })
  label!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;

  @ApiProperty()
  depth!: number;

  @ApiProperty({ description: 'Produits actifs offrant cette taille' })
  productCount!: number;

  @ApiProperty({ type: [Number], description: 'Cotes MERV offertes dans cette taille' })
  mervValues!: number[];
}

export class SizeIndexDto {
  @ApiProperty({ type: [SizeIndexItemDto] })
  sizes!: SizeIndexItemDto[];
}

/* ------------------------ Équivalences de tailles ------------------------ */

export class EquivalentSizeDto {
  @ApiProperty({ example: '16x25x1' })
  label!: string;

  @ApiProperty({ type: DimensionsDto, description: 'Dimensions nominales (pouces)' })
  nominal!: DimensionsDto;

  @ApiProperty({ type: DimensionsDto, description: 'Dimensions réelles (pouces)' })
  actual!: DimensionsDto;

  @ApiProperty({ description: 'Cette taille est offerte au catalogue' })
  inCatalog!: boolean;
}

export class SizeEquivalentsDto {
  @ApiProperty({ description: 'Saisie normalisée', example: '16x25x1' })
  input!: string;

  @ApiProperty({ description: 'Libellé canonique', example: '16x25x1' })
  canonical!: string;

  @ApiProperty({
    type: [String],
    description: 'Libellés équivalents présents au catalogue (à interroger)',
  })
  catalogLabels!: string[];

  @ApiProperty({ type: [EquivalentSizeDto] })
  equivalents!: EquivalentSizeDto[];
}

/* -------------------------------- Sitemap -------------------------------- */

export class SitemapProductDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: LocalizedSlugsDto })
  slugs!: LocalizedSlugsDto;

  @ApiProperty({ format: 'date-time', description: 'Dernière modification (lastmod)' })
  updatedAt!: string;
}

export class SitemapCategoryDto {
  @ApiProperty({ type: LocalizedSlugsDto })
  slugs!: LocalizedSlugsDto;
}

/** Matière première des sitemaps de la vitrine : toutes les URL indexables. */
export class SitemapDto {
  @ApiProperty({ type: [SitemapProductDto], description: 'Produits actifs' })
  products!: SitemapProductDto[];

  @ApiProperty({ type: [SitemapCategoryDto], description: 'Catégories actives' })
  categories!: SitemapCategoryDto[];

  @ApiProperty({ type: [String], description: 'Libellés nominaux des tailles au catalogue' })
  sizes!: string[];
}

/* ------------------------------ Suggestions ------------------------------ */

export class SizeSuggestionDto {
  @ApiProperty({ example: '16x25x1' })
  label!: string;

  @ApiProperty()
  productCount!: number;
}

export class ProductSuggestionDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  priceFromCents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;
}

export class SuggestDto {
  @ApiProperty({ type: [SizeSuggestionDto] })
  sizes!: SizeSuggestionDto[];

  @ApiProperty({ type: [ProductSuggestionDto] })
  products!: ProductSuggestionDto[];
}
