import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import {
  DEFAULT_STALE_DAYS,
  TrackingAdminService,
} from '../shipping/tracking/tracking-admin.service';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { TrackingOverviewDto, TrackingOverviewQueryDto } from './dto/tracking.dto';

/**
 * Observabilité du SUIVI DE COLIS (tâche 14).
 *
 * Une seule vue, en lecture : métriques par transporteur (colis suivis,
 * erreurs, latence, alerte d'échecs en série) et tableau des colis
 * « bloqués » sans mise à jour depuis N jours. L'écran complet arrive à la
 * tâche 22 ; l'API est prête.
 */
@AdminGuarded()
@Controller('admin/tracking')
export class AdminTrackingController {
  constructor(private readonly tracking: TrackingAdminService) {}

  @Get()
  @RequirePermissions('shipments.read')
  @ApiOperation({
    summary: 'Observabilité du suivi de colis (métriques par transporteur, colis bloqués)',
    operationId: 'adminTrackingOverview',
  })
  @ApiOkResponse({ type: TrackingOverviewDto })
  overview(@Query() query: TrackingOverviewQueryDto): Promise<TrackingOverviewDto> {
    return this.tracking.overview(query.staleDays ?? DEFAULT_STALE_DAYS);
  }
}
