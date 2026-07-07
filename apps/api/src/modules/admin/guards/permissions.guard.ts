import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { grantsPermission } from '@ffc/core';
import { ADMIN_PERMISSIONS_KEY, type AdminRequest } from '../admin-authz';
import { PermissionService } from '../permission.service';

/**
 * RBAC fin côté serveur (tâche 09). S'exécute APRÈS les gardes globales
 * (JWT + rôle STAFF/ADMIN + MFA) : `request.user` est déjà chargé et frais.
 *
 * Pour toute route décorée `@RequirePermissions(...)`, charge les permissions
 * effectives du compte et exige TOUTES les permissions listées. Sans le
 * décorateur, la route reste protégée par le rôle + la MFA (garde globale) —
 * utile pour les routes « tout admin » (profil, step-up). Le serveur fait foi,
 * peu importe ce que l'interface affiche.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ADMIN_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const { user } = request;
    if (!user) throw new ForbiddenException('Accès refusé.');

    // Permissions mémorisées sur la requête (réutilisées par le contrôleur).
    const granted = await this.permissions.effectivePermissions(user.id);
    request.adminPermissions = granted;

    if (!required || required.length === 0) return true;

    const missing = required.filter((permission) => !grantsPermission(granted, permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Permission insuffisante : ${missing.join(', ')}.`);
    }
    return true;
  }
}
