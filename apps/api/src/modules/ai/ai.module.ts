import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../config/env';
import { AiController } from './ai.controller';
import { AiDevUploadController } from './ai-dev-upload.controller';
import { AiMatchingService } from './ai-matching.service';
import { aiPhotoStorageProvider } from './ai-photo-storage';
import { AiProcessorService } from './ai-processor.service';
import { AiPurgeService } from './ai-purge.service';
import { AiQueueService } from './ai-queue.service';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AnthropicVisionProvider } from './ai-vision/anthropic.provider';
import { LogVisionProvider } from './ai-vision/log.provider';
import { OpenAiVisionProvider } from './ai-vision/openai.provider';
import { VISION_PROVIDER, type VisionProvider } from './ai-vision/vision-provider';

/**
 * IA de reconnaissance de filtre par photo (tâche 17) : téléversement
 * présigné sécurisé, analyse de vision à sortie structurée derrière
 * l'interface multi-fournisseurs `VisionProvider` (AI_VISION_DRIVER :
 * log | anthropic | openai), correspondance vers `equipment_models` et les
 * variantes, seuil de confiance → file de révision, quotas et purge 30 jours
 * (Loi 25). Les écrans client/admin arrivent aux tâches 18 et 19.
 */
@Module({
  controllers: [AiController, AiDevUploadController],
  providers: [
    aiPhotoStorageProvider,
    LogVisionProvider,
    {
      provide: VISION_PROVIDER,
      inject: [ConfigService, LogVisionProvider],
      useFactory: (config: ConfigService<Env, true>, log: LogVisionProvider): VisionProvider => {
        switch (config.get('AI_VISION_DRIVER', { infer: true })) {
          case 'anthropic':
            return new AnthropicVisionProvider(
              config.get('ANTHROPIC_API_KEY', { infer: true }),
              config.get('ANTHROPIC_VISION_MODEL', { infer: true }),
            );
          case 'openai':
            return new OpenAiVisionProvider(
              config.get('OPENAI_API_KEY', { infer: true }),
              config.get('OPENAI_VISION_MODEL', { infer: true }),
            );
          default:
            return log;
        }
      },
    },
    AiSettingsService,
    AiMatchingService,
    AiProcessorService,
    AiPurgeService,
    AiQueueService,
    AiService,
  ],
  exports: [AiProcessorService, AiPurgeService],
})
export class AiModule {}
