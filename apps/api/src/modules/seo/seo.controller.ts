import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ReportNotFoundDto } from './dto/seo.dto';
import { SeoNotFoundService } from './seo-not-found.service';

/**
 * Signalement public des 404 de la vitrine (tâche 25 §7). Appelé par le
 * serveur Next.js (jamais par le navigateur) après chaque page introuvable :
 * aucune donnée personnelle, réponse vide, et le plafond quotidien du service
 * borne les abus.
 */
@ApiTags('seo')
@Controller('seo')
export class SeoController {
  constructor(private readonly notFound: SeoNotFoundService) {}

  @Public()
  @Post('not-found')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Signale un 404 servi par la vitrine (vigie SEO post-bascule)',
    operationId: 'reportStorefrontNotFound',
  })
  @ApiNoContentResponse()
  async report(@Body() body: ReportNotFoundDto): Promise<void> {
    await this.notFound.record({ host: body.host, path: body.path, referer: body.referer ?? null });
  }
}
