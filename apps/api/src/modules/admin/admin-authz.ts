import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { type AdminPermissionKey } from '@ffc/core';
import { type AuthenticatedRequest } from '../auth/request-context';

/**
 * Métadonnées et décorateurs de l'autorisation admin (tâche 09).
 *
 * Séparés des gardes pour éviter les cycles d'import : les gardes lisent ces
 * clés, le décorateur composite `@AdminGuarded()` (admin-guarded.decorator.ts)
 * assemble les gardes.
 */

/** En-tête portant le jeton de ré-authentification « step-up ». */
export const STEP_UP_HEADER = 'x-step-up-token';

export const ADMIN_PERMISSIONS_KEY = 'ffc:admin:permissions';
export const ADMIN_STEP_UP_KEY = 'ffc:admin:stepUp';
export const ADMIN_AUDIT_ACTION_KEY = 'ffc:admin:auditAction';
export const ADMIN_AUDIT_MANUAL_KEY = 'ffc:admin:auditManual';

/**
 * Permissions granulaires exigées par la route (ET logique). Appliqué côté
 * serveur par `PermissionsGuard`; le serveur fait toujours foi, même si
 * l'interface masque déjà l'action.
 */
export const RequirePermissions = (...permissions: AdminPermissionKey[]): CustomDecorator =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);

/**
 * Action sensible : exige un jeton de step-up récent (`X-Step-Up-Token`) en
 * plus de la session — remboursements, changements de rôles, exports…
 */
export const RequireStepUp = (): CustomDecorator => SetMetadata(ADMIN_STEP_UP_KEY, true);

/**
 * Nomme l'action consignée par l'intercepteur d'audit (« ressource.verbe »).
 * Absent → dérivée de la méthode HTTP et de la route.
 */
export const AuditAction = (action: string): CustomDecorator =>
  SetMetadata(ADMIN_AUDIT_ACTION_KEY, action);

/**
 * La route consigne elle-même son audit détaillé (avant/après) : l'intercepteur
 * ne double PAS l'entrée.
 */
export const AuditManual = (): CustomDecorator => SetMetadata(ADMIN_AUDIT_MANUAL_KEY, true);

/** Requête admin : l'ensemble des permissions effectives est mémorisé par la garde. */
export interface AdminRequest extends AuthenticatedRequest {
  adminPermissions?: Set<string>;
}
