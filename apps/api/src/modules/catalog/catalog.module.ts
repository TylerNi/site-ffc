import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SearchService } from './search.service';
import { SizeService } from './size.service';

/**
 * Catalogue et recherche (tâche 06) : endpoints publics du catalogue,
 * recherche full-text/trigram et équivalences de tailles. PrismaModule est
 * global — pas besoin de le réimporter.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, SearchService, SizeService],
  exports: [CatalogService, SizeService],
})
export class CatalogModule {}
