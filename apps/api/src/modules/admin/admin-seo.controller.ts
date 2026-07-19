import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { SeoNotFoundService } from '../seo/seo-not-found.service';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { NotFoundReportDto, NotFoundReportQueryDto } from './dto/seo.dto';

/**
 * Vigie SEO post-bascule (tâche 25 §7) : rapport quotidien des 404 servis
 * par la vitrine — les URLs BigCommerce oubliées par la table de redirections
 * remontent ici, puis reçoivent une décision (`data/redirections-decisions.json`)
 * et un redéploiement de l'artefact. Procédure : docs/vigie-seo.md.
 */
@AdminGuarded()
@Controller('admin/seo')
export class AdminSeoController {
  constructor(private readonly notFound: SeoNotFoundService) {}

  @Get('not-found')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Rapport quotidien des 404 de la vitrine (vigie SEO post-bascule)',
    operationId: 'adminSeoNotFoundReport',
  })
  @ApiOkResponse({ type: NotFoundReportDto })
  report(@Query() query: NotFoundReportQueryDto): Promise<NotFoundReportDto> {
    const day = query.day
      ? new Date(`${query.day}T00:00:00.000Z`)
      : SeoNotFoundService.dayOf(new Date());
    return this.notFound.dailyReport(day, query.limit ?? 20);
  }
}
