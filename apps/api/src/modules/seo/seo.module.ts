import { Module } from '@nestjs/common';
import { SeoController } from './seo.controller';
import { SeoNotFoundService } from './seo-not-found.service';

/**
 * Vigie SEO post-bascule (tâche 25) : collecte publique des 404 de la
 * vitrine, rapport quotidien côté admin (contrôleur dans AdminModule, qui
 * importe ce module pour le service).
 */
@Module({
  controllers: [SeoController],
  providers: [SeoNotFoundService],
  exports: [SeoNotFoundService],
})
export class SeoModule {}
