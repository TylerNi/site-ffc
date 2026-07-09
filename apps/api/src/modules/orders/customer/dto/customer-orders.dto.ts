import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CURRENCIES, type Currency, ORDER_STATUSES, type OrderStatus } from '@ffc/core';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderAddressDto, OrderLineSummaryDto } from '../../checkout/dto/checkout.dto';

/* -------------------------------- Requêtes ------------------------------- */

export class ListMyOrdersQueryDto {
  @ApiPropertyOptional({
    description: 'Nombre max de commandes (défaut 20)',
    minimum: 1,
    maximum: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Curseur : id de la dernière commande de la page précédente',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}

/* -------------------------------- Sorties -------------------------------- */

export class OrderStatusEventDto {
  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty({ description: 'Libellé localisé du statut' })
  label!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  note?: string | null;

  @ApiProperty({ enum: ['client', 'admin', 'system'], description: 'Auteur de la transition' })
  actor!: 'client' | 'admin' | 'system';

  @ApiProperty({ format: 'date-time' })
  at!: string;
}

export class MyOrderListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'FFC-100042' })
  number!: string;

  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty()
  statusLabel!: string;

  @ApiProperty({ format: 'date-time' })
  placedAt!: string;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty()
  totalCents!: number;

  @ApiProperty({ description: 'Nombre total d’articles' })
  itemCount!: number;

  @ApiProperty({ description: 'Le client peut annuler (avant expédition)' })
  canCancel!: boolean;

  @ApiProperty({ description: 'Une facture est disponible au téléchargement' })
  hasInvoice!: boolean;
}

export class MyOrdersPageDto {
  @ApiProperty({ type: [MyOrderListItemDto] })
  items!: MyOrderListItemDto[];

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Curseur de la page suivante' })
  nextCursor?: string | null;
}

export class RefundLineDto {
  @ApiProperty()
  amountCents!: number;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason?: string | null;
}

export class MyOrderDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  number!: string;

  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty()
  statusLabel!: string;

  @ApiProperty({ format: 'date-time' })
  placedAt!: string;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty({ type: [OrderLineSummaryDto] })
  lines!: OrderLineSummaryDto[];

  @ApiProperty()
  subtotalCents!: number;

  @ApiProperty()
  discountCents!: number;

  @ApiProperty()
  shippingCents!: number;

  @ApiProperty({ description: 'TPS (cents)' })
  taxGstCents!: number;

  @ApiProperty({ description: 'TVQ (cents)' })
  taxQstCents!: number;

  @ApiProperty({ description: 'TVH (cents)' })
  taxHstCents!: number;

  @ApiProperty({ description: 'TVP/TVD (cents)' })
  taxPstCents!: number;

  @ApiProperty({ description: 'Total des taxes (cents)' })
  totalTaxCents!: number;

  @ApiProperty()
  totalCents!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  couponCode?: string | null;

  @ApiProperty({ type: OrderAddressDto })
  shippingAddress!: OrderAddressDto;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Marque de carte (reçu)' })
  cardBrand?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: '4 derniers chiffres' })
  cardLast4?: string | null;

  @ApiProperty({ type: [OrderStatusEventDto], description: 'Chronologie datée avec acteurs' })
  timeline!: OrderStatusEventDto[];

  @ApiProperty({ type: [RefundLineDto] })
  refunds!: RefundLineDto[];

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Numéro de facture' })
  invoiceNumber?: string | null;

  @ApiProperty({ description: 'Une facture est disponible au téléchargement' })
  hasInvoice!: boolean;

  @ApiProperty({ description: 'Le client peut annuler (avant expédition)' })
  canCancel!: boolean;
}

export class CancelOrderResponseDto {
  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Montant remboursé (cents) — null si rien à rembourser',
  })
  refundAmountCents?: number | null;
}

export class CancelOrderRequestDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Motif facultatif du client' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
