import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_STEP_UP_KEY, type AdminRequest, STEP_UP_HEADER } from '../admin-authz';
import { StepUpService } from '../step-up.service';

/**
 * Impose une ré-authentification récente sur les routes `@RequireStepUp()`
 * (tâche 09). Refuse (403 avec un code distinctif) si l'en-tête
 * `X-Step-Up-Token` est absent ou invalide, pour que l'interface sache
 * demander le second facteur puis rejouer la requête.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUp: StepUpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_STEP_UP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const { user, authClaims } = request;
    if (!user || !authClaims) throw new ForbiddenException('Accès refusé.');

    const header = request.headers[STEP_UP_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !(await this.stepUp.verify(token, user.id, authClaims.sid))) {
      throw new ForbiddenException({
        code: 'STEP_UP_REQUIRED',
        message:
          'Cette action sensible exige une ré-authentification récente (step-up). Confirmez votre code puis réessayez.',
      });
    }
    return true;
  }
}
