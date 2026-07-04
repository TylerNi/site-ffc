import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/decorators';

class AdminPingResponseDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ description: 'Rôle du compte authentifié' })
  role!: string;
}

/**
 * Socle des routes admin (complété en tâche 09 — RBAC fin).
 *
 * TOUTE route de ce contrôleur exige : JWT valide + rôle STAFF/ADMIN +
 * MFA ACTIVE (RolesGuard) — un admin sans MFA reçoit 403 partout ici.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Roles('STAFF', 'ADMIN')
@Controller('admin')
export class AdminController {
  @Get('ping')
  @ApiOperation({
    summary: 'Sonde d’accès admin (JWT + rôle du personnel + MFA active)',
    operationId: 'adminPing',
  })
  @ApiOkResponse({ type: AdminPingResponseDto })
  ping(@CurrentUser() user: User): AdminPingResponseDto {
    return { status: 'ok', role: user.role };
  }
}
