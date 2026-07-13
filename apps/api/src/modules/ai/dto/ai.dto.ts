import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AI_ANALYSIS_MODES, AI_IDENTIFICATION_STATUSES, AI_MATCH_KINDS } from '@ffc/core';
import { Equals, IsBoolean, IsIn } from 'class-validator';

/** Corps de création d'une identification (téléversement présigné). */
export class CreateAiIdentificationDto {
  @ApiProperty({
    enum: AI_ANALYSIS_MODES,
    description:
      'Mode d’analyse : EQUIPMENT_LABEL (plaque signalétique — mode A) ou FILTER_FRAME (cadre du filtre — mode B, le plus fiable).',
  })
  @IsIn(AI_ANALYSIS_MODES)
  mode!: (typeof AI_ANALYSIS_MODES)[number];

  @ApiProperty({
    description:
      'Consentement EXPLICITE à l’analyse de la photo par un fournisseur d’IA (transfert hors Québec — Loi 25). Doit être true.',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'Le consentement explicite est requis pour analyser une photo (consent doit être true).',
  })
  consent!: boolean;
}

export class AiPhotoUploadDto {
  @ApiProperty({
    description: 'URL cible du POST multipart (S3 présigné, ou relais local en dev).',
  })
  url!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Champs à joindre au formulaire multipart, avant le fichier.',
  })
  fields!: Record<string, string>;

  @ApiProperty({ description: 'Taille maximale acceptée (octets), imposée par la politique S3.' })
  maxBytes!: number;

  @ApiProperty({ description: 'Durée de validité de l’URL présignée (secondes).' })
  expiresInSeconds!: number;
}

export class AiVisionFieldDto {
  @ApiProperty({ nullable: true, type: String })
  value!: string | null;

  @ApiProperty({ description: 'Confiance 0–1.' })
  confidence!: number;
}

export class AiVisionDimensionsDto {
  @ApiProperty({ nullable: true, type: Number })
  widthIn!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  heightIn!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  depthIn!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Libellé canonique « LxHxP » si largeur et hauteur sont lues.',
  })
  label!: string | null;

  @ApiProperty({ description: 'Confiance 0–1.' })
  confidence!: number;
}

export class AiVisionMervDto {
  @ApiProperty({ nullable: true, type: Number })
  value!: number | null;

  @ApiProperty({ description: 'Confiance 0–1.' })
  confidence!: number;
}

/** Résultat d'extraction exposé au propriétaire (sous-ensemble de l'enveloppe JSONB). */
export class AiExtractionResultDto {
  @ApiProperty({ type: AiVisionFieldDto })
  manufacturer!: AiVisionFieldDto;

  @ApiProperty({ type: AiVisionFieldDto })
  modelNumber!: AiVisionFieldDto;

  @ApiProperty({ type: AiVisionDimensionsDto })
  dimensions!: AiVisionDimensionsDto;

  @ApiProperty({ type: AiVisionMervDto })
  merv!: AiVisionMervDto;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Texte lisible transcrit de la photo.',
  })
  readableText!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    enum: [...AI_ANALYSIS_MODES, null],
    description: 'Mode suggéré si la photo ressemble manifestement à l’autre mode.',
  })
  suggestedMode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;
}

export class AiMatchedEquipmentModelDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  manufacturer!: string;

  @ApiProperty()
  modelNumber!: string;
}

export class AiMatchCandidateDto {
  @ApiProperty()
  equipmentModelId!: string;

  @ApiProperty()
  manufacturer!: string;

  @ApiProperty()
  modelNumber!: string;

  @ApiProperty({ description: 'Similarité pg_trgm 0–1.' })
  similarity!: number;
}

export class AiMatchDto {
  @ApiProperty({ enum: AI_MATCH_KINDS })
  kind!: string;

  @ApiProperty({ nullable: true, type: Number })
  score!: number | null;

  @ApiProperty({ type: [AiMatchCandidateDto] })
  candidates!: AiMatchCandidateDto[];
}

export class AiSuggestedVariantDto {
  @ApiProperty()
  variantId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ example: '16x25x1' })
  nominalLabel!: string;

  @ApiProperty({ nullable: true, type: Number })
  merv!: number | null;

  @ApiProperty()
  packSize!: number;

  @ApiProperty({ description: 'true si la cote MERV extraite correspond exactement.' })
  mervMatches!: boolean;
}

export class AiIdentificationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: AI_ANALYSIS_MODES })
  mode!: string;

  @ApiProperty({ enum: AI_IDENTIFICATION_STATUSES })
  status!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'Confiance globale 0–1.' })
  confidence!: number | null;

  @ApiProperty({ nullable: true, type: String })
  failureReason!: string | null;

  @ApiProperty({ nullable: true, type: AiExtractionResultDto })
  result!: AiExtractionResultDto | null;

  @ApiProperty({ nullable: true, type: AiMatchDto })
  match!: AiMatchDto | null;

  @ApiProperty({ nullable: true, type: AiMatchedEquipmentModelDto })
  matchedEquipmentModel!: AiMatchedEquipmentModelDto | null;

  @ApiProperty({ type: [AiSuggestedVariantDto] })
  suggestedVariants!: AiSuggestedVariantDto[];

  @ApiProperty({ description: 'Date de purge planifiée de la photo et de l’extraction (Loi 25).' })
  purgeAt!: string;

  @ApiProperty({ nullable: true, type: String })
  purgedAt!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CreateAiIdentificationResponseDto {
  @ApiProperty({ type: AiIdentificationDto })
  identification!: AiIdentificationDto;

  @ApiProperty({ type: AiPhotoUploadDto })
  upload!: AiPhotoUploadDto;
}
