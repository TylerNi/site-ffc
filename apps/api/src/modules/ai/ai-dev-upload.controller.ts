import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsBase64, IsString, Matches, MaxLength } from 'class-validator';
import { type Env } from '../../config/env';
import { Public } from '../auth/decorators';
import { AI_PHOTO_STORAGE, type AiPhotoStorage, MAX_AI_PHOTO_BYTES } from './ai-photo-storage';

class AiDevUploadDto {
  @IsString()
  @MaxLength(400)
  @Matches(/^ai\//, { message: 'Clé hors du préfixe ai/ refusée.' })
  key!: string;

  @IsBase64()
  dataBase64!: string;
}

/**
 * Relais de téléversement DEV/TEST UNIQUEMENT (même mécanique que
 * `dev-upload.controller.ts`, tâche 10). Sans bucket S3 configuré, l'URL
 * présignée des photos IA pointe ici : le client exerce le parcours complet
 * en local. Applique la même borne de taille que la politique S3 réelle.
 *
 * Refuse systématiquement (404) dès qu'un vrai bucket est configuré — ce
 * relais n'existe JAMAIS fonctionnellement en production.
 */
@ApiExcludeController()
@Public()
@Controller('ai/dev-uploads')
export class AiDevUploadController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(AI_PHOTO_STORAGE) private readonly storage: AiPhotoStorage,
  ) {}

  @Post()
  async upload(@Body() dto: AiDevUploadDto): Promise<{ ok: true }> {
    if (this.config.get('S3_AI_PHOTOS_BUCKET', { infer: true })) {
      throw new NotFoundException();
    }
    const bytes = Buffer.from(dto.dataBase64, 'base64');
    if (bytes.length < 1 || bytes.length > MAX_AI_PHOTO_BYTES) {
      throw new BadRequestException('Taille refusée par la politique (1 octet à 10 Mo).');
    }
    await this.storage.put(dto.key, bytes, 'application/octet-stream');
    return { ok: true };
  }
}
