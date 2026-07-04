import { Injectable, Logger } from '@nestjs/common';
import { type Prisma } from '@prisma/client';
import { PrismaService } from '../../database';

export interface AuditEntry {
  /** « user », « system », « webhook »… */
  actorType?: string;
  actorId?: string | null;
  /** Courriel figé au moment de l'action (survit à l'anonymisation). */
  actorEmail?: string | null;
  /** Action au format « ressource.verbe » (ex. « auth.login.success »). */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Écriture dans le journal d'audit append-only (`audit_logs`).
 *
 * Les événements d'authentification (succès, échecs, réinitialisations,
 * MFA…) passent tous par ici. Une erreur d'écriture est journalisée mais
 * ne fait JAMAIS échouer le parcours appelant : refuser une connexion
 * parce que l'audit est indisponible serait un déni de service.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType ?? 'user',
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          before: entry.before,
          after: entry.after,
          metadata: entry.metadata,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Écriture d'audit impossible (action=${entry.action})`, error);
    }
  }
}
