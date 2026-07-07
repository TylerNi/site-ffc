import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type User } from '@prisma/client';
import { CurrentUser, Public } from '../auth/decorators';
import { MessageResponseDto } from '../auth/dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from '../auth/request-context';
import { AdminGuarded } from './admin-guarded.decorator';
import { AuditManual, RequirePermissions, RequireStepUp } from './admin-authz';
import { AdminUsersService } from './admin-users.service';
import {
  AcceptInvitationDto,
  AdminUserDto,
  AssignRolesDto,
  InviteAdminDto,
  PermissionDto,
  RoleDto,
} from './dto/admin.dto';

/**
 * Comptes du personnel (tâche 09) : liste avec dernier accès, invitation,
 * attribution de rôles, désactivation. Toutes les mutations exigent la
 * permission `admin_users.write` ET une ré-authentification récente (step-up),
 * et consignent un audit détaillé avant/après.
 */
@AdminGuarded()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermissions('admin_users.read')
  @ApiOperation({ summary: 'Liste des comptes du personnel', operationId: 'adminListUsers' })
  @ApiOkResponse({ type: [AdminUserDto] })
  list(): Promise<AdminUserDto[]> {
    return this.users.list();
  }

  @Post('invitations')
  @RequirePermissions('admin_users.write')
  @RequireStepUp()
  @AuditManual()
  @ApiOperation({
    summary: 'Invite un compte du personnel (courriel + rôles)',
    operationId: 'adminInviteUser',
  })
  @ApiOkResponse({ type: AdminUserDto })
  invite(
    @Body() dto: InviteAdminDto,
    @CurrentUser() actor: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserDto> {
    return this.users.invite(actor, dto, requestContext(req));
  }

  @Patch(':id/roles')
  @RequirePermissions('admin_users.write')
  @RequireStepUp()
  @AuditManual()
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Remplace les rôles d’un compte du personnel',
    operationId: 'adminAssignRoles',
  })
  @ApiOkResponse({ type: AdminUserDto })
  assignRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRolesDto,
    @CurrentUser() actor: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserDto> {
    return this.users.assignRoles(actor, id, dto.roleKeys, requestContext(req));
  }

  @Post(':id/deactivate')
  @RequirePermissions('admin_users.write')
  @RequireStepUp()
  @AuditManual()
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Désactive un compte du personnel (révoque ses sessions)',
    operationId: 'adminDeactivateUser',
  })
  @ApiOkResponse({ type: AdminUserDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserDto> {
    return this.users.deactivate(actor, id, requestContext(req));
  }

  @Post(':id/reactivate')
  @RequirePermissions('admin_users.write')
  @RequireStepUp()
  @AuditManual()
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Réactive un compte du personnel', operationId: 'adminReactivateUser' })
  @ApiOkResponse({ type: AdminUserDto })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserDto> {
    return this.users.reactivate(actor, id, requestContext(req));
  }
}

/** Consultation des rôles et permissions (pour attribuer et pour l'interface). */
@AdminGuarded()
@Controller('admin/roles')
export class AdminRolesController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'Liste des rôles et de leurs permissions',
    operationId: 'adminListRoles',
  })
  @ApiOkResponse({ type: [RoleDto] })
  listRoles(): Promise<RoleDto[]> {
    return this.users.listRoles();
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'Catalogue des permissions granulaires',
    operationId: 'adminListPermissions',
  })
  @ApiOkResponse({ type: [PermissionDto] })
  listPermissions(): Promise<PermissionDto[]> {
    return this.users.listPermissions();
  }
}

/**
 * Acceptation d'invitation — PUBLIC par nécessité (le compte invité n'a pas
 * encore de session). Le jeton à usage unique reçu par courriel fait foi.
 */
@ApiTags('admin')
@Controller('admin/invitations')
export class AdminInvitationController {
  constructor(private readonly users: AdminUsersService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accepte une invitation admin (définit le mot de passe)',
    operationId: 'adminAcceptInvitation',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  accept(
    @Body() dto: AcceptInvitationDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.users.acceptInvitation(dto, requestContext(req));
  }
}
