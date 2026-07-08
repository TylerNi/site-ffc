import {
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { type User, type UserRole } from '@prisma/client';
import { type AccessTokenClaims } from './token.service';
import { type AuthenticatedRequest } from './request-context';

export const IS_PUBLIC_KEY = 'ffc:isPublic';
/** Route accessible sans access token (login, santé, webhooks…). */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const OPTIONAL_AUTH_KEY = 'ffc:optionalAuth';
/**
 * Authentification FACULTATIVE (panier, checkout — tâche 11) : sans en-tête
 * Authorization la requête passe en anonyme ; avec un Bearer, il est vérifié
 * normalement (un jeton invalide reste un 401 franc — jamais de session
 * silencieusement ignorée).
 */
export const OptionalAuth = (): CustomDecorator => SetMetadata(OPTIONAL_AUTH_KEY, true);

export const ROLES_KEY = 'ffc:roles';
/**
 * Rôles système exigés. Dès qu'un rôle du personnel (STAFF/ADMIN) est
 * exigé, RolesGuard impose AUSSI une MFA active (brief tâche 05 : aucune
 * route admin accessible sans MFA).
 */
export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);

/** Utilisateur courant (chargé de la base par JwtAuthGuard). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) throw new Error('CurrentUser utilisé sur une route sans JwtAuthGuard');
  return request.user;
});

/** Claims du JWT courant (dont `sid`, l'id de session). */
export const CurrentClaims = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authClaims)
      throw new Error('CurrentClaims utilisé sur une route sans JwtAuthGuard');
    return request.authClaims;
  },
);
