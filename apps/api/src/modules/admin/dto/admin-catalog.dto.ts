import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CURRENCIES, type Currency, LOCALES, type Locale, PRODUCT_STATUSES } from '@ffc/core';
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  type AllowedImageContentType,
} from '../product-image-storage';

/** Slug URL : minuscules, chiffres, tirets simples — jamais de tiret en tête/queue. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/* --------------------------------- Requêtes -------------------------------- */

export class AdminProductListQueryDto {
  @ApiPropertyOptional({ description: 'Recherche libre (nom, SKU)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'Dimension nominale (n’importe quelle graphie)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dimension?: string;

  @ApiPropertyOptional({ description: 'Cote MERV exacte' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  merv?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: PRODUCT_STATUSES })
  @IsOptional()
  @IsIn(PRODUCT_STATUSES)
  status?: (typeof PRODUCT_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Curseur : id du dernier produit reçu' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/* --------------------------------- Réponses --------------------------------- */

export class AdminBrandRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
}

export class AdminCategoryRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  name!: string | null;
}

export class AdminProductTranslationDto {
  @ApiProperty({ enum: LOCALES })
  locale!: Locale;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  shortDescription!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  metaTitle!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  metaDescription!: string | null;
}

export class AdminInventorySummaryDto {
  @ApiProperty()
  quantityOnHand!: number;

  @ApiProperty()
  quantityReserved!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  lowStockThreshold!: number | null;
}

export class AdminVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  barcode!: string | null;

  @ApiProperty()
  nominalLabel!: string;

  @ApiProperty() nominalWidthIn!: number;
  @ApiProperty() nominalHeightIn!: number;
  @ApiProperty() nominalDepthIn!: number;
  @ApiProperty() actualWidthIn!: number;
  @ApiProperty() actualHeightIn!: number;
  @ApiProperty() actualDepthIn!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  merv!: number | null;

  @ApiProperty()
  packSize!: number;

  @ApiProperty()
  priceCents!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  compareAtPriceCents!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  costCents!: number | null;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiPropertyOptional({ nullable: true, type: Number })
  weightGrams!: number | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  position!: number;

  @ApiPropertyOptional({ type: AdminInventorySummaryDto, nullable: true })
  inventory!: AdminInventorySummaryDto | null;
}

export class AdminProductImageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Clé S3 (relative) ou URL' })
  url!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  altFr!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  altEn!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  width!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  height!: number | null;

  @ApiProperty()
  position!: number;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  variantId!: string | null;
}

export class AdminProductListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PRODUCT_STATUSES })
  status!: (typeof PRODUCT_STATUSES)[number];

  @ApiProperty()
  isFeatured!: boolean;

  @ApiProperty({ type: AdminBrandRefDto })
  brand!: AdminBrandRefDto;

  @ApiPropertyOptional({ type: AdminCategoryRefDto, nullable: true })
  category!: AdminCategoryRefDto | null;

  @ApiProperty({
    type: [String],
    description: 'Locales traduites (badge « traduction manquante » côté interface)',
  })
  translatedLocales!: Locale[];

  @ApiProperty({ description: 'Nom affiché (première traduction disponible)' })
  name!: string;

  @ApiPropertyOptional({ type: AdminProductImageDto, nullable: true })
  image!: AdminProductImageDto | null;

  @ApiProperty()
  variantCount!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  priceFromCents!: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class AdminProductListDto {
  @ApiProperty({ type: [AdminProductListItemDto] })
  items!: AdminProductListItemDto[];

  @ApiProperty()
  hasMore!: boolean;

  @ApiPropertyOptional({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class AdminProductDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PRODUCT_STATUSES })
  status!: (typeof PRODUCT_STATUSES)[number];

  @ApiProperty()
  isFeatured!: boolean;

  @ApiProperty({ type: AdminBrandRefDto })
  brand!: AdminBrandRefDto;

  @ApiPropertyOptional({ type: AdminCategoryRefDto, nullable: true })
  category!: AdminCategoryRefDto | null;

  @ApiProperty({ type: [AdminProductTranslationDto] })
  translations!: AdminProductTranslationDto[];

  @ApiProperty({ type: [AdminVariantDto] })
  variants!: AdminVariantDto[];

  @ApiProperty({ type: [AdminProductImageDto] })
  images!: AdminProductImageDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

/* ------------------------------- Mutations ------------------------------- */

export class CreateProductDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  brandId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}

export class UpsertProductTranslationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ description: 'minuscules, chiffres, tirets simples', example: 'filtre-16x25x1' })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'Slug invalide (minuscules, chiffres, tirets simples).' })
  @MaxLength(160)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  shortDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  metaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  metaDescription?: string;
}

/* --------------------------------- Variantes -------------------------------- */

export class CreateVariantDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  sku!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;

  @ApiProperty({ example: '16x25x1' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  nominalLabel!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalWidthIn!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalHeightIn!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalDepthIn!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualWidthIn!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualHeightIn!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualDepthIn!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  merv?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  packSize?: number;

  @ApiProperty({ description: 'Prix en CENTS' })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceCents!: number;

  @ApiPropertyOptional({ description: 'Prix barré en CENTS' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  compareAtPriceCents?: number;

  @ApiPropertyOptional({ description: 'Coût d’achat en CENTS' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  costCents?: number;

  @ApiPropertyOptional({ enum: CURRENCIES, default: 'CAD' })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: Currency;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200_000)
  weightGrams?: number;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  sku?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  barcode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  nominalLabel?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalWidthIn?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalHeightIn?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  nominalDepthIn?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualWidthIn?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualHeightIn?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(999.99)
  actualDepthIn?: number;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  merv?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  packSize?: number;
  @ApiPropertyOptional({ description: 'Prix en CENTS' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceCents?: number;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  compareAtPriceCents?: number;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  costCents?: number;
  @ApiPropertyOptional({ enum: CURRENCIES })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: Currency;
  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200_000)
  weightGrams?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/* ---------------------------------- Images ---------------------------------- */

export class PresignImageUploadDto {
  @ApiProperty({ enum: ALLOWED_IMAGE_CONTENT_TYPES })
  @IsIn(ALLOWED_IMAGE_CONTENT_TYPES)
  contentType!: AllowedImageContentType;
}

export class PresignImageUploadResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty({ type: Object, description: 'Champs multipart à joindre avant le fichier' })
  fields!: Record<string, string>;
}

export class RegisterImageDto {
  @ApiProperty({ description: 'Clé S3 retournée par l’URL présignée' })
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  key!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  altFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  altEn?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Image propre à une variante précise' })
  @IsOptional()
  @IsUUID()
  variantId?: string;
}

export class UpdateImageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  altFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  altEn?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  @IsOptional()
  @IsUUID()
  variantId?: string | null;
}

export class ReorderImagesDto {
  @ApiProperty({ type: [String], description: 'Ensemble complet des images, dans le nouvel ordre' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  imageIds!: string[];
}

/* ------------------------------- Catégories -------------------------------- */

export class CategoryTranslationInputDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty()
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'Slug invalide (minuscules, chiffres, tirets simples).' })
  @MaxLength(160)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class CategoryTranslationsInputDto {
  @ApiPropertyOptional({ type: CategoryTranslationInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CategoryTranslationInputDto)
  fr?: CategoryTranslationInputDto;

  @ApiPropertyOptional({ type: CategoryTranslationInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CategoryTranslationInputDto)
  en?: CategoryTranslationInputDto;
}

export class CreateCategoryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiProperty({ type: CategoryTranslationsInputDto })
  @ValidateNested()
  @Type(() => CategoryTranslationsInputDto)
  translations!: CategoryTranslationsInputDto;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: CategoryTranslationsInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CategoryTranslationsInputDto)
  translations?: CategoryTranslationsInputDto;
}

export class MoveCategoryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'null = racine',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

export class AdminCategoryTranslationDto {
  @ApiProperty({ enum: LOCALES })
  locale!: Locale;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;
}

export class AdminCategoryNodeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  parentId!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ description: 'Produits associés (directement, hors sous-arbre)' })
  productCount!: number;

  @ApiProperty({ type: [AdminCategoryTranslationDto] })
  translations!: AdminCategoryTranslationDto[];

  @ApiProperty({ type: () => [AdminCategoryNodeDto] })
  children!: AdminCategoryNodeDto[];
}

export class AdminCategoryTreeDto {
  @ApiProperty({ type: [AdminCategoryNodeDto] })
  categories!: AdminCategoryNodeDto[];
}

/* ---------------------------------- Marques ---------------------------------- */

export class AdminBrandDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  logoUrl!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  productCount!: number;
}

export class CreateBrandDto {
  @ApiProperty()
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'Slug invalide (minuscules, chiffres, tirets simples).' })
  @MaxLength(80)
  slug!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'Slug invalide (minuscules, chiffres, tirets simples).' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
