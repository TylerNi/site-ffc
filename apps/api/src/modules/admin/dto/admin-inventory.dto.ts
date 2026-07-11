import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { INVENTORY_MOVEMENT_TYPES, type InventoryMovementType } from '@ffc/core';

/** Types de mouvement pilotables depuis l'admin — SALE reste réservé au checkout. */
export const ADMIN_ADJUSTABLE_MOVEMENT_TYPES = ['RECEIPT', 'RETURN', 'ADJUSTMENT'] as const;
export type AdminAdjustableMovementType = (typeof ADMIN_ADJUSTABLE_MOVEMENT_TYPES)[number];

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

export class AdminInventoryQueryDto {
  @ApiPropertyOptional({ description: 'Recherche par SKU ou nom de produit' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ description: 'Ne garder que les variantes sous leur seuil d’alerte' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  lowStockOnly?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdminInventoryItemDto {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  nominalLabel!: string;

  @ApiProperty()
  quantityOnHand!: number;

  @ApiProperty()
  quantityReserved!: number;

  @ApiProperty({ description: 'En main − réservée' })
  availableQuantity!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  lowStockThreshold!: number | null;

  @ApiProperty()
  isLowStock!: boolean;
}

export class AdminInventoryPageDto {
  @ApiProperty({ type: [AdminInventoryItemDto] })
  items!: AdminInventoryItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

export class SetThresholdDto {
  @ApiProperty({ nullable: true, type: Number, description: 'null = aucune alerte' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lowStockThreshold!: number | null;
}

export class AdjustInventoryDto {
  @ApiProperty({ enum: ADMIN_ADJUSTABLE_MOVEMENT_TYPES })
  @IsIn(ADMIN_ADJUSTABLE_MOVEMENT_TYPES)
  type!: AdminAdjustableMovementType;

  @ApiProperty({
    description: 'Delta SIGNÉ (positif = entrée, négatif = sortie/bris/correction à la baisse)',
  })
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  quantity!: number;

  @ApiProperty({ description: 'Motif — OBLIGATOIRE (réception, correction, bris…)' })
  @IsString()
  @IsNotEmpty({ message: 'Le motif est obligatoire.' })
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class AdminInventoryMovementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: INVENTORY_MOVEMENT_TYPES })
  type!: InventoryMovementType;

  @ApiProperty()
  quantity!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  orderId!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid' })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  createdByEmail!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminInventoryMovementQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AdminInventoryMovementPageDto {
  @ApiProperty({ type: [AdminInventoryMovementDto] })
  items!: AdminInventoryMovementDto[];

  @ApiPropertyOptional({ nullable: true, type: String })
  nextCursor!: string | null;
}
