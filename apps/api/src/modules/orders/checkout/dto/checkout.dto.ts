import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CURRENCIES, type Currency, LOCALES, type Locale, SHIPPING_COUNTRIES } from '@ffc/core';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CartChangesDto } from '../../cart/dto/cart.dto';

/* --------------------------------- Adresse ------------------------------- */

/**
 * Forme brute d'une adresse de checkout. La validation FINE (province par
 * pays, format postal CA/US, normalisation) est faite en service par
 * `checkoutAddressSchema` de @ffc/core — même règle que la vitrine.
 */
export class CheckoutAddressDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  company?: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  city!: string;

  @ApiProperty({ description: 'Code de province (CA) ou d’état (US)', example: 'QC' })
  @IsString()
  @MaxLength(3)
  province!: string;

  @ApiProperty({ description: 'Code postal (A1A 1A1) ou ZIP (12345[-6789])', maxLength: 12 })
  @IsString()
  @MaxLength(12)
  postalCode!: string;

  @ApiProperty({ enum: SHIPPING_COUNTRIES })
  @IsIn([...SHIPPING_COUNTRIES])
  country!: 'CA' | 'US';

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

/* ------------------------------ Créer session ---------------------------- */

export class CreateCheckoutSessionDto {
  @ApiPropertyOptional({
    description: 'Courriel de commande — REQUIS pour un invité, ignoré si connecté',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: LOCALES, description: 'Langue des courriels et de la facture' })
  @IsOptional()
  @IsIn([...LOCALES])
  locale?: Locale;

  @ApiPropertyOptional({ type: CheckoutAddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  shippingAddress?: CheckoutAddressDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Adresse du carnet (compte connecté) — exclusif avec shippingAddress',
  })
  @IsOptional()
  @IsUUID()
  shippingAddressId?: string;

  @ApiPropertyOptional({
    type: CheckoutAddressDto,
    description: 'Défaut : identique à la livraison',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  billingAddress?: CheckoutAddressDto;

  @ApiPropertyOptional({ description: 'Sauvegarder l’adresse au carnet (connecté seulement)' })
  @IsOptional()
  @IsBoolean()
  saveAddress?: boolean;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  couponCode?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customerNote?: string;
}

/* --------------------------------- Sorties ------------------------------- */

export class OrderLineSummaryDto {
  @ApiProperty()
  sku!: string;

  @ApiProperty()
  nameFr!: string;

  @ApiProperty()
  nameEn!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  nominalLabel?: string | null;

  @ApiProperty()
  packSize!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  merv?: number | null;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  unitPriceCents!: number;

  @ApiProperty({ description: 'Part de la remise imputée à cette ligne (cents)' })
  discountCents!: number;

  @ApiProperty({ description: 'unitPrice × quantity − remise (cents)' })
  subtotalCents!: number;

  @ApiProperty({ description: 'Taxes de la ligne, toutes composantes (cents)' })
  taxCents!: number;

  @ApiProperty()
  totalCents!: number;
}

export class OrderAddressDto {
  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  company?: string | null;

  @ApiProperty()
  line1!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  line2?: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  province!: string;

  @ApiProperty()
  postalCode!: string;

  @ApiProperty({ enum: SHIPPING_COUNTRIES })
  country!: 'CA' | 'US';

  @ApiPropertyOptional({ nullable: true, type: String })
  phone?: string | null;
}

export class OrderSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'FFC-100042' })
  number!: string;

  @ApiProperty({ enum: CURRENCIES })
  currency!: Currency;

  @ApiProperty()
  email!: string;

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
}

export class CheckoutSessionDto {
  @ApiProperty({ description: 'client_secret du PaymentIntent — alimente le Payment Element' })
  clientSecret!: string;

  @ApiProperty()
  paymentIntentId!: string;

  @ApiProperty({ type: OrderSummaryDto })
  order!: OrderSummaryDto;
}

/* ---------------------------------- Résultat ----------------------------- */

export class CheckoutResultRequestDto {
  @ApiProperty({ example: 'pi_3Nxxxx' })
  @IsString()
  @MaxLength(255)
  paymentIntentId!: string;

  @ApiProperty({
    description: 'client_secret du même intent — preuve de possession de la session de paiement',
  })
  @IsString()
  @MaxLength(255)
  clientSecret!: string;
}

export const CHECKOUT_RESULT_STATUSES = [
  'paid',
  'processing',
  'requires_action',
  'payment_failed',
  'cancelled',
  'cancelled_insufficient_stock',
] as const;
export type CheckoutResultStatus = (typeof CHECKOUT_RESULT_STATUSES)[number];

export class CheckoutResultDto {
  @ApiProperty({
    enum: CHECKOUT_RESULT_STATUSES,
    description:
      'paid : commande payée · processing : paiement en cours · payment_failed : refusé (réessayer) · cancelled_insufficient_stock : payé puis annulé-remboursé (dernier article parti)',
  })
  status!: CheckoutResultStatus;

  @ApiPropertyOptional({ type: OrderSummaryDto, nullable: true })
  order?: OrderSummaryDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Message d’échec de paiement (déjà localisé par Stripe quand disponible)',
  })
  failureMessage?: string | null;
}

/* ------------------------------ Erreur 409 panier ------------------------ */

export class CartChangedErrorDto {
  @ApiProperty({ example: 'CART_CHANGED' })
  code!: string;

  @ApiProperty({ type: CartChangesDto })
  changes!: CartChangesDto;

  @ApiProperty()
  message!: string;
}
