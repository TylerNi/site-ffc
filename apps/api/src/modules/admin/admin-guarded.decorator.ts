import { applyDecorators, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { PermissionsGuard } from './guards/permissions.guard';
import { StepUpGuard } from './guards/step-up.guard';

/**
 * Socle commun de TOUT contrôleur admin (tâche 09) — le préfixe `/v1/admin`
 * n'est jamais nu :
 *   - `@Roles('STAFF','ADMIN')` : lu par la garde globale RolesGuard → JWT
 *     valide + rôle du personnel + **MFA active** (tâche 05);
 *   - `PermissionsGuard` : RBAC fin (`@RequirePermissions`) — après les
 *     gardes globales, donc `request.user` est chargé;
 *   - `StepUpGuard` : ré-auth récente (`@RequireStepUp`) pour les actions
 *     sensibles;
 *   - `AdminAuditInterceptor` : journalise automatiquement les mutations.
 *
 * Les gardes de contrôleur s'exécutent TOUJOURS après les gardes globales :
 * l'ordre (rôle+MFA → permission → step-up) est garanti sans dépendre de
 * l'ordre d'enregistrement des providers.
 */
export function AdminGuarded(): ClassDecorator {
  return applyDecorators(
    ApiTags('admin'),
    ApiBearerAuth(),
    Roles('STAFF', 'ADMIN'),
    UseGuards(PermissionsGuard, StepUpGuard),
    UseInterceptors(AdminAuditInterceptor),
  );
}
