import { Body, Controller, Inject, NotFoundException, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsBase64, IsString, MaxLength } from 'class-validator';
import { type Env } from '../../config/env';
import { Public } from '../auth/decorators';
import { PRODUCT_IMAGE_STORAGE, type ProductImageStorage } from './product-image-storage';

class DevUploadDto {
  @IsString()
  @MaxLength(400)
  key!: string;

  @IsBase64()
  dataBase64!: string;
}

/**
 * Relais de téléversement DEV/TEST UNIQUEMENT (tâche 10). Sans bucket S3
 * configuré, l'URL présignée des images produit pointe ici plutôt que vers
 * AWS (voir `InMemoryProductImageStorage`) : le navigateur peut quand même
 * exercer le parcours complet de téléversement en local.
 *
 * Refuse systématiquement (404) dès qu'un vrai bucket est configuré — ce
 * relais n'existe JAMAIS fonctionnellement en production, où le navigateur
 * parle directement à S3 via l'URL présignée réelle.
 */
@ApiExcludeController()
@Public()
@Controller('dev/uploads')
export class DevUploadController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(PRODUCT_IMAGE_STORAGE) private readonly storage: ProductImageStorage,
  ) {}

  @Post()
  async upload(@Body() dto: DevUploadDto): Promise<{ ok: true }> {
    if (this.config.get('S3_BUCKET_PRODUCT_IMAGES', { infer: true })) {
      throw new NotFoundException();
    }
    await this.storage.put(dto.key, Buffer.from(dto.dataBase64, 'base64'));
    return { ok: true };
  }
}
