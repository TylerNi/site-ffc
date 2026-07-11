import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { RevalidationClient } from './revalidation.client';
import { SearchService } from './search.service';
import { SizeService } from './size.service';

/**
 * Catalogue et recherche (tâche 06) : endpoints publics du catalogue,
 * recherche full-text/trigram et équivalences de tailles. PrismaModule est
 * global — pas besoin de le réimporter. `RevalidationClient` (tâche 10) vit
 * ici : c'est le pendant « vitrine » de la publication admin, réutilisé par
 * AdminModule.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, SearchService, SizeService, RevalidationClient],
  exports: [CatalogService, SizeService, RevalidationClient],
})
export class CatalogModule {}
