import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EQUIPMENT_KINDS, type EquipmentKind, LOCALES, type Locale } from '@ffc/core';
import { MAX_PAGE_SIZE } from '../catalog.util';

/** Tris offerts sur les listes et la recherche. */
export const CATALOG_SORTS = ['relevance', 'price', 'popularity'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** Convertit une chaîne de requête (« true »/« 1 ») en booléen. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

/** Filtres communs à la liste de produits et à la recherche. */
export class CatalogFilterQueryDto {
  @ApiPropertyOptional({ enum: LOCALES, default: 'fr', description: 'Langue des libellés/slugs' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @ApiPropertyOptional({
    description:
      'Dimension en n’importe quelle graphie : « 16x25x1 », « 16 x 25 x 1 », « 16-25-1 », ' +
      '« 15 3/4 x 24 3/4 » (réelle). Nominal et réel, orientation indifférente.',
    example: '16x25x1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dimension?: string;

  @ApiPropertyOptional({ description: 'Cote MERV exacte', example: 11 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  merv?: number;

  @ApiPropertyOptional({ description: 'Slug de marque', example: 'boreal-filtration' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string;

  @ApiPropertyOptional({ description: 'Slug de catégorie (localisé) — inclut les sous-catégories' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({
    enum: EQUIPMENT_KINDS,
    description: 'Type d’équipement compatible (fournaise, échangeur d’air…)',
  })
  @IsOptional()
  @IsIn(EQUIPMENT_KINDS)
  equipmentKind?: EquipmentKind;

  @ApiPropertyOptional({ description: 'Format de boîte (filtres par unité de vente)', example: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  packSize?: number;

  @ApiPropertyOptional({ description: 'Profondeur nominale en pouces (1, 4, 5…)', example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  depth?: number;

  @ApiPropertyOptional({ description: 'Ne garder que les produits en stock' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  inStock?: boolean;

  @ApiPropertyOptional({ enum: CATALOG_SORTS, default: 'relevance' })
  @IsOptional()
  @IsIn(CATALOG_SORTS)
  sort?: CatalogSort;

  @ApiPropertyOptional({ description: 'Curseur opaque de pagination (voir nextCursor)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ description: `Taille de page (max ${MAX_PAGE_SIZE})`, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** Requête de recherche : texte OU dimension OBLIGATOIRE, plus les mêmes filtres. */
export class SearchQueryDto extends CatalogFilterQueryDto {
  @ApiPropertyOptional({
    description: 'Requête : texte (nom, marque), SKU, ou dimension. Tolérante aux fautes.',
    example: '16x25x1 merv 11',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  q!: string;
}

/** Requête d’autocomplétion. */
export class SuggestQueryDto {
  @ApiPropertyOptional({ enum: LOCALES, default: 'fr' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @ApiPropertyOptional({ description: 'Début de saisie', example: '16x2' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  q!: string;

  @ApiPropertyOptional({ description: 'Nombre max de suggestions par catégorie', default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

/** Requête ne portant qu’une locale (arbre de catégories, index des tailles). */
export class LocaleQueryDto {
  @ApiPropertyOptional({ enum: LOCALES, default: 'fr' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;
}
