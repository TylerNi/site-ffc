import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  ORDER_STATUSES,
  SHIPSTATION_SYNC_OPERATIONS,
  SHIPSTATION_SYNC_STATUSES,
  type ShipstationSyncOperation,
  type ShipstationSyncStatus,
} from '@ffc/core';

/* -------------------------------- Requête --------------------------------- */

export class ShipstationSyncQueryDto {
  @ApiPropertyOptional({
    enum: SHIPSTATION_SYNC_STATUSES,
    default: 'SYNC_FAILED',
    description: 'Statut de synchronisation (défaut : la file d’échec)',
  })
  @IsOptional()
  @IsIn([...SHIPSTATION_SYNC_STATUSES])
  status?: ShipstationSyncStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Curseur : id de la dernière ligne reçue' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/* -------------------------------- Réponses -------------------------------- */

export class ShipstationSyncDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ example: 'FFC-100042' })
  orderNumber!: string;

  @ApiProperty({ enum: ORDER_STATUSES })
  orderStatus!: string;

  @ApiProperty({ description: 'Total de la commande (cents)' })
  totalCents!: number;

  @ApiProperty({ example: 'CAD' })
  currency!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  paidAt!: string | null;

  @ApiProperty({ enum: SHIPSTATION_SYNC_STATUSES })
  status!: ShipstationSyncStatus;

  @ApiProperty({ enum: SHIPSTATION_SYNC_OPERATIONS })
  operation!: ShipstationSyncOperation;

  @ApiProperty({ description: 'Tentatives consommées' })
  attempts!: number;

  @ApiProperty({ nullable: true, type: String, description: 'Cause du dernier échec' })
  lastError!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastAttemptAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  nextAttemptAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Identifiant de la commande ShipStation',
  })
  shipstationOrderId!: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class ShipstationSyncCountsDto {
  @ApiProperty() PENDING!: number;
  @ApiProperty() SYNCED!: number;
  @ApiProperty() SYNC_FAILED!: number;
  @ApiProperty() CANCELLED!: number;
  @ApiProperty() SKIPPED!: number;
}

export class ShipstationSyncPageDto {
  @ApiProperty({ type: [ShipstationSyncDto] })
  items!: ShipstationSyncDto[];

  @ApiProperty({ nullable: true, type: String, description: 'Curseur de la page suivante' })
  nextCursor!: string | null;

  @ApiProperty({ type: ShipstationSyncCountsDto })
  counts!: ShipstationSyncCountsDto;

  @ApiProperty({ description: 'Les clés API ShipStation sont configurées sur ce serveur' })
  configured!: boolean;
}
