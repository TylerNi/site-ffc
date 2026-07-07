import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminAuditService } from './admin-audit.service';
import { AuditLogPageDto, AuditLogQueryDto } from './dto/admin.dto';

/**
 * Journal d'audit consultable (tâche 09) — LECTURE SEULE. Aucune route de
 * modification/suppression : le journal est append-only par conception.
 */
@AdminGuarded()
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({
    summary: 'Consulte le journal d’audit (filtrable, paginé)',
    operationId: 'adminListAuditLogs',
  })
  @ApiOkResponse({ type: AuditLogPageDto })
  list(@Query() query: AuditLogQueryDto): Promise<AuditLogPageDto> {
    return this.audit.query(query);
  }
}
