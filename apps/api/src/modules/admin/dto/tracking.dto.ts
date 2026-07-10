import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CARRIERS, type Carrier, SHIPMENT_STATUSES, type ShipmentStatus } from '@ffc/core';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Vue d'observabilité du suivi de colis (tâche 14) — /v1/admin/tracking. */

export class TrackingOverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Un colis actif sans mise à jour depuis N jours est « bloqué » (défaut 5)',
    minimum: 1,
    maximum: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  staleDays?: number;
}

export class CarrierMetricsDto {
  @ApiProperty({ description: 'Appels de repérage depuis le démarrage du worker' })
  polls!: number;

  @ApiProperty()
  ok!: number;

  @ApiProperty({ description: 'Réponses « numéro inconnu » (normales au début)' })
  notFound!: number;

  @ApiProperty()
  failures!: number;

  @ApiProperty()
  consecutiveFailures!: number;

  @ApiProperty({ description: 'Alerte levée : l’adapter échoue en série' })
  alertActive!: boolean;

  @ApiPropertyOptional({ nullable: true, type: Number })
  lastLatencyMs?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  avgLatencyMs?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastSuccessAt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastErrorAt?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  lastError?: string | null;
}

export class CarrierOverviewDto {
  @ApiProperty({ enum: CARRIERS })
  carrier!: Carrier;

  @ApiProperty({ description: 'Clés d’accès configurées (adapter opérationnel)' })
  configured!: boolean;

  @ApiProperty({ description: 'Colis actifs suivis (ni livrés ni retournés)' })
  active!: number;

  @ApiProperty({ description: 'Colis actifs par statut', type: Object })
  byStatus!: Partial<Record<ShipmentStatus, number>>;

  @ApiProperty({ description: 'Colis actifs sans mise à jour depuis N jours' })
  stale!: number;

  @ApiPropertyOptional({ type: CarrierMetricsDto, nullable: true })
  metrics?: CarrierMetricsDto | null;
}

export class StaleShipmentDto {
  @ApiProperty({ format: 'uuid' })
  shipmentId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiPropertyOptional({ enum: CARRIERS, nullable: true })
  carrier?: Carrier | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  trackingNumber?: string | null;

  @ApiProperty({ enum: SHIPMENT_STATUSES })
  status!: ShipmentStatus;

  @ApiProperty({ format: 'date-time', description: 'Dernier mouvement connu' })
  lastMovementAt!: string;

  @ApiProperty()
  daysWithoutUpdate!: number;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  nextPollAt?: string | null;

  @ApiProperty({ description: 'Échecs de repérage consécutifs' })
  pollFailures!: number;
}

export class TrackingOverviewDto {
  @ApiProperty()
  staleDays!: number;

  @ApiProperty({ type: [CarrierOverviewDto] })
  carriers!: CarrierOverviewDto[];

  @ApiProperty({ type: [StaleShipmentDto], description: 'Colis bloqués, les plus anciens d’abord' })
  staleShipments!: StaleShipmentDto[];
}
