import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators';
import { type AuthenticatedRequest } from '../request-context';

/** Rôles considérés « personnel » : MFA imposée par le serveur. */
const STAFF_ROLES: readonly UserRole[] = ['STAFF', 'ADMIN'];

/**
 * Contrôle des rôles (@Roles) — s'exécute APRÈS JwtAuthGuard, sur
 * l'utilisateur fraîchement rechargé.
 *
 * Exigence du brief tâche 05 : dès qu'une route demande un rôle du
 * personnel, une MFA ACTIVE est requise en plus du rôle. Un admin sans
 * MFA doit d'abord l'activer (routes /v1/auth/mfa/*, simplement
 * authentifiées) avant d'atteindre la moindre route admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) return false; // route @Public + @Roles : incohérent → refus

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Accès refusé.');
    }

    const staffRoleRequired = requiredRoles.some((role) => STAFF_ROLES.includes(role));
    if (staffRoleRequired && !user.mfaEnabled) {
      throw new ForbiddenException(
        'MFA obligatoire pour le personnel : activez-la via /v1/auth/mfa avant d’accéder aux routes admin.',
      );
    }
    return true;
  }
}
