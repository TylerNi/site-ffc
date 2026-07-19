import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Signalement d'un 404 par la vitrine (vigie SEO post-bascule, tâche 25). */
export class ReportNotFoundDto {
  @ApiProperty({ description: 'Hôte demandé (en-tête Host de la requête 404)', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @ApiProperty({
    description: 'Chemin demandé (tronqué à 400 caractères en base)',
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  path!: string;

  @ApiPropertyOptional({
    description: 'En-tête Referer (tronqué à 500 caractères en base)',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  referer?: string;
}
