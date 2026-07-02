import { ApiProperty } from '@nestjs/swagger';
import { type HealthStatus } from '@ffc/core';

/** Miroir OpenAPI du schéma zod `healthStatusSchema` de @ffc/core. */
export class HealthResponseDto implements HealthStatus {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ example: 'ffc-api' })
  service!: string;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ minimum: 0 })
  uptimeSeconds!: number;
}
