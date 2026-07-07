import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, tap } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { ADMIN_AUDIT_ACTION_KEY, ADMIN_AUDIT_MANUAL_KEY, type AdminRequest } from './admin-authz';

/** Méthodes considérées comme des mutations (consignées automatiquement). */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Journalise automatiquement toute mutation admin réussie dans `audit_logs`
 * (tâche 09) : acteur, action, entité, IP, horodatage.
 *
 * Les routes qui consignent elles-mêmes un audit détaillé (avant/après) sont
 * marquées `@AuditManual()` et ignorées ici — pas de double entrée. Les
 * lectures (GET) ne sont pas des mutations et ne sont pas journalisées.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const method = request.method.toUpperCase();

    const manual = this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_AUDIT_MANUAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (manual || !MUTATION_METHODS.has(method)) return next.handle();

    const explicitAction = this.reflector.getAllAndOverride<string | undefined>(
      ADMIN_AUDIT_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    const routePath = (request.route as { path?: string } | undefined)?.path ?? request.path;
    const action =
      explicitAction ?? `admin.${method.toLowerCase()}${routePath.replace(/\//g, '.')}`;

    return next.handle().pipe(
      tap((body) => {
        const user = request.user;
        const resultId =
          body && typeof body === 'object' && 'id' in body && typeof body.id === 'string'
            ? body.id
            : null;
        void this.audit.log({
          action,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          entityId: typeof request.params?.id === 'string' ? request.params.id : null,
          metadata: {
            method,
            path: request.originalUrl.split('?')[0],
            params: request.params ?? {},
            resultId,
          },
          ip: request.ip ?? null,
          userAgent:
            typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent'].slice(0, 400)
              : null,
        });
      }),
    );
  }
}
