import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../database';
import { IS_PUBLIC_KEY } from '../decorators';
import { type AuthenticatedRequest } from '../request-context';
import { TokenService } from '../token.service';

/**
 * Guard global d'authentification : Bearer JWT exigé partout, sauf sur
 * les routes @Public().
 *
 * Le compte est RECHARGÉ de la base à chaque requête : un compte
 * désactivé/anonymisé perd l'accès immédiatement (sans attendre
 * l'expiration du JWT), et rôle/MFA sont toujours frais pour RolesGuard.
 * Coût : un SELECT par clé primaire — négligeable à notre échelle.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthorizedException('Authentification requise.');

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    request.user = user;
    request.authClaims = claims;
    return true;
  }
}
