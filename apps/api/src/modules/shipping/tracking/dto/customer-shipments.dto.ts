import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CARRIERS, type Carrier, SHIPMENT_STATUSES, type ShipmentStatus } from '@ffc/core';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/* -------------------------------- Requêtes ------------------------------- */

export class ListMyShipmentsQueryDto {
  @ApiPropertyOptional({ description: 'Nombre max de colis (défaut 20)', minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Curseur : id du dernier colis de la page précédente' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}

/* -------------------------------- Sorties -------------------------------- */

export class ShipmentEventDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Code source du transporteur' })
  code?: string | null;

  @ApiPropertyOptional({
    enum: SHIPMENT_STATUSES,
    nullable: true,
    description: 'Statut normalisé (null : événement informatif)',
  })
  status?: ShipmentStatus | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Libellé localisé du statut' })
  statusLabel?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  location?: string | null;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: string;
}

export class MyShipmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Commande liée (page « Mes commandes »)' })
  orderId!: string;

  @ApiProperty({ example: 'FFC-100042' })
  orderNumber!: string;

  @ApiPropertyOptional({ enum: CARRIERS, nullable: true })
  carrier?: Carrier | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Libellé localisé du transporteur',
  })
  carrierLabel?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  trackingNumber?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Page de repérage publique du transporteur',
  })
  trackingUrl?: string | null;

  @ApiProperty({ enum: SHIPMENT_STATUSES })
  status!: ShipmentStatus;

  @ApiProperty({ description: 'Libellé localisé du statut' })
  statusLabel!: string;

  @ApiProperty({ description: 'false : livré ou retourné (historique)' })
  isActive!: boolean;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  shippedAt?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  estimatedDeliveryAt?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  deliveredAt?: string | null;

  @ApiProperty({
    type: [ShipmentEventDto],
    description: 'Chronologie normalisée, du plus récent au plus ancien',
  })
  events!: ShipmentEventDto[];
}

export class MyShipmentsPageDto {
  @ApiProperty({ type: [MyShipmentDto] })
  items!: MyShipmentDto[];

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Curseur de la page suivante' })
  nextCursor?: string | null;
}
