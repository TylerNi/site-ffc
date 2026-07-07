import { Injectable } from '@nestjs/common';
import { type AuditLog, type Prisma } from '@prisma/client';
import { PrismaService } from '../../database';
import { type AuditLogDto, type AuditLogPageDto, type AuditLogQueryDto } from './dto/admin.dto';

const DEFAULT_LIMIT = 50;

/**
 * Consultation du journal d'audit (tâche 09) — LECTURE SEULE. Le journal est
 * append-only (trigger SQL, tâche 04) : aucune route de modification ni de
 * suppression n'existe. Filtrage par acteur, entité, action et période;
 * pagination par curseur stable (createdAt desc, id desc).
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async query(params: AuditLogQueryDto): Promise<AuditLogPageDto> {
    const limit = params.limit ?? DEFAULT_LIMIT;

    const where: Prisma.AuditLogWhereInput = {};
    if (params.actorId) where.actorId = params.actorId;
    if (params.entityType) where.entityType = params.entityType;
    if (params.entityId) where.entityId = params.entityId;
    if (params.action) where.action = { startsWith: params.action };
    if (params.from || params.to) {
      where.createdAt = {
        ...(params.from ? { gte: new Date(params.from) } : {}),
        ...(params.to ? { lt: new Date(params.to) } : {}),
      };
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.toDto(row));
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  private toDto(row: AuditLog): AuditLogDto {
    return {
      id: row.id,
      actorType: row.actorType,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      metadata: row.metadata,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
