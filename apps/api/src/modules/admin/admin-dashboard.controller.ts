import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminDashboardService } from './admin-dashboard.service';
import { DashboardSummaryDto } from './dto/admin.dto';

/** Tableau de bord d'accueil de l'administration (tâche 09). */
@AdminGuarded()
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('summary')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Tuiles du tableau de bord (ventes, files, stock)',
    operationId: 'adminDashboardSummary',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(): Promise<DashboardSummaryDto> {
    return this.dashboard.summary();
  }
}
