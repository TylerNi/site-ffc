import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CURRENCIES, type Currency } from '@ffc/core';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/** Quantité maximale par ligne — garde-fou contre les saisies absurdes. */
export const MAX_LINE_QUANTITY = 99;

/* --------------------------------- Entrées ------------------------------- */

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid', description: 'Variante de produit à ajouter' })
  @IsUUID()
  variantId!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_LINE_QUANTITY, example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export class UpdateCartItemDto {
  @ApiProperty({ minimum: 1, maximum: MAX_LINE_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

/* --------------------------------- Sorties ------------------------------- */

export class CartLineDto {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ description: 'Prix courant de la variante (cents) — recalculé à chaque lecture' })
  unitPriceCents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty({ description: 'quantity × unitPriceCents' })
  lineSubtotalCents!: number;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  slugFr?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  slugEn?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '16x25x1' })
  nominalLabel?: string | null;

  @ApiProperty()
  packSize!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  merv?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  imageUrl?: string | null;

  @ApiProperty({ description: 'Stock vendable restant (en main − réservé)' })
  availableQuantity!: number;
}

export const CART_LINE_REMOVAL_REASONS = ['UNAVAILABLE', 'OUT_OF_STOCK'] as const;
export type CartLineRemovalReason = (typeof CART_LINE_REMOVAL_REASONS)[number];

export class RemovedCartLineDto {
  @ApiProperty()
  sku!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiProperty({
    enum: CART_LINE_REMOVAL_REASONS,
    description: 'UNAVAILABLE : produit retiré du catalogue · OUT_OF_STOCK : épuisé',
  })
  reason!: CartLineRemovalReason;
}

export class AdjustedCartLineDto {
  @ApiProperty()
  sku!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiProperty({ description: 'Quantité demandée avant ajustement' })
  fromQuantity!: number;

  @ApiProperty({ description: 'Quantité retenue (stock restant)' })
  toQuantity!: number;
}

export class PriceChangedCartLineDto {
  @ApiProperty()
  sku!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiProperty({ description: 'Prix consigné à l’ajout (cents)' })
  fromCents!: number;

  @ApiProperty({ description: 'Prix courant (cents)' })
  toCents!: number;
}

/**
 * Écarts constatés et CORRIGÉS pendant la lecture : lignes retirées
 * (produit dépublié/épuisé), quantités rabattues au stock restant, prix
 * qui ont bougé depuis l'ajout. Chaque écart n'est signalé qu'une fois —
 * le panier renvoyé est déjà réconcilié.
 */
export class CartChangesDto {
  @ApiProperty({ type: [RemovedCartLineDto] })
  removed!: RemovedCartLineDto[];

  @ApiProperty({ type: [AdjustedCartLineDto] })
  adjusted!: AdjustedCartLineDto[];

  @ApiProperty({ type: [PriceChangedCartLineDto] })
  priceChanged!: PriceChangedCartLineDto[];
}

export class CartDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Null tant qu’aucun panier n’existe pour ce client',
  })
  id!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Jeton de panier invité — présent UNIQUEMENT à la création (première addition sans compte). À stocker côté client et à renvoyer dans X-Cart-Token.',
  })
  guestCartToken?: string | null;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty({ type: [CartLineDto] })
  items!: CartLineDto[];

  @ApiProperty({ description: 'Somme des lignes (cents) — les taxes se calculent au checkout' })
  subtotalCents!: number;

  @ApiProperty({ description: 'Nombre total d’unités' })
  itemCount!: number;

  @ApiProperty({ type: CartChangesDto })
  changes!: CartChangesDto;
}
