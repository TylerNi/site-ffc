import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type User } from '@prisma/client';
import { type Request } from 'express';
import { CurrentUser } from '../auth/decorators';
import { requestContext } from '../auth/request-context';
import { AiService } from './ai.service';
import {
  AiIdentificationDto,
  CreateAiIdentificationDto,
  CreateAiIdentificationResponseDto,
} from './dto/ai.dto';

/**
 * Identification de filtre par photo (tâche 17). Bearer OBLIGATOIRE en v1
 * (aucun `@Public` — le JwtAuthGuard global exige un compte) ; le service ne
 * lit et n'écrit que les identifications de CE compte. En plus du quota
 * quotidien par utilisateur (429 côté service), un @Throttle par IP borne
 * les rafales.
 */
@ApiTags('ia')
@ApiBearerAuth()
@Controller('ai/identifications')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post()
  @Throttle({ default: { limit: 30, ttl: 15 * 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Créer une identification et obtenir l’URL de téléversement présignée',
    description:
      'Exige un consentement explicite (consent: true — refus 400, tracé au journal d’audit). Répond 429 au-delà du quota quotidien, 503 si le fournisseur de vision n’est pas configuré.',
    operationId: 'createAiIdentification',
  })
  @ApiCreatedResponse({ type: CreateAiIdentificationResponseDto })
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateAiIdentificationDto,
    @Req() req: Request,
  ): Promise<CreateAiIdentificationResponseDto> {
    return this.ai.create(user, dto, requestContext(req));
  }

  @Post(':id/submit')
  @Throttle({ default: { limit: 30, ttl: 15 * 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Soumettre la photo téléversée à l’analyse',
    description:
      'Valide le CONTENU réel (octets magiques JPEG/PNG/WebP/HEIC), ré-encode l’image sans EXIF (GPS), remplace l’objet S3 puis met l’analyse en file.',
    operationId: 'submitAiIdentification',
  })
  @ApiOkResponse({ type: AiIdentificationDto })
  submit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiIdentificationDto> {
    return this.ai.submit(user, id);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Statut et résultat d’une identification (propriétaire seulement)',
    operationId: 'getAiIdentification',
  })
  @ApiOkResponse({ type: AiIdentificationDto })
  get(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiIdentificationDto> {
    return this.ai.get(user, id);
  }
}
