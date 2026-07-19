import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Rapport quotidien des 404 de la vitrine (tâche 25) — /v1/admin/seo. */

export class NotFoundReportQueryDto {
  @ApiPropertyOptional({
    description: 'Jour UTC au format YYYY-MM-DD (défaut : aujourd’hui)',
    example: '2026-07-19',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day doit être au format YYYY-MM-DD' })
  day?: string;

  @ApiPropertyOptional({
    description: 'Top N chemins par hôte (défaut 20)',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class NotFoundPathReportDto {
  @ApiProperty()
  path!: string;

  @ApiProperty({ description: 'Requêtes 404 sur ce chemin ce jour-là' })
  hits!: number;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Dernier Referer observé' })
  lastReferer!: string | null;

  @ApiProperty({ format: 'date-time' })
  lastSeenAt!: string;
}

export class NotFoundHostReportDto {
  @ApiProperty()
  host!: string;

  @ApiProperty({ description: 'Total des requêtes 404 du jour pour cet hôte' })
  totalHits!: number;

  @ApiProperty({ description: 'Chemins distincts en 404 ce jour-là' })
  distinctPaths!: number;

  @ApiProperty({ type: [NotFoundPathReportDto], description: 'Chemins les plus touchés d’abord' })
  top!: NotFoundPathReportDto[];
}

export class NotFoundReportDto {
  @ApiProperty({ description: 'Jour UTC du rapport (YYYY-MM-DD)' })
  day!: string;

  @ApiProperty({ type: [NotFoundHostReportDto] })
  hosts!: NotFoundHostReportDto[];
}
