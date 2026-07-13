import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseAiExtractionEnvelope } from '@ffc/core';
import { type Prisma } from '@prisma/client';
import { PrismaService } from '../../database';
import { AI_PHOTO_STORAGE, type AiPhotoStorage } from './ai-photo-storage';

/**
 * Purge à 30 jours (Loi 25, tâche 17). `purgeAt` est fixé À LA CRÉATION ;
 * ce job quotidien supprime l'objet S3 **et** efface l'extraction (remplacée
 * par un marqueur minimal), puis pose `purgedAt`. La BD est la source de
 * vérité — le cycle de vie S3 (30 jours, Terraform) n'est qu'un filet.
 *
 * Idempotent : une relance ne retrouve rien (`purgedAt` posé) et l'effacement
 * BD est conditionnel (`purgedAt: null`) — aucun effet au deuxième passage.
 */
@Injectable()
export class AiPurgeService {
  private readonly logger = new Logger(AiPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PHOTO_STORAGE) private readonly storage: AiPhotoStorage,
  ) {}

  async purgeDue(now: Date = new Date()): Promise<{ purged: number; failed: number }> {
    const due = await this.prisma.aiIdentification.findMany({
      where: { purgeAt: { lte: now }, purgedAt: null },
      select: { id: true, imageKey: true, extraction: true },
      orderBy: { purgeAt: 'asc' },
      take: 500,
    });

    let purged = 0;
    let failed = 0;
    for (const row of due) {
      // S3 d'abord : la BD ne marque « purgé » que si l'objet est réellement
      // parti — en cas d'échec S3, la ligne reste due et repassera demain.
      try {
        await this.storage.delete(row.imageKey);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Purge : suppression S3 impossible pour ${row.id} — nouvel essai au prochain passage.`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      const mode = parseAiExtractionEnvelope(row.extraction)?.mode;
      const marker = {
        ...(mode ? { mode } : {}),
        purge: { purgedAt: now.toISOString() },
      };
      const updated = await this.prisma.aiIdentification.updateMany({
        where: { id: row.id, purgedAt: null },
        data: { extraction: marker as Prisma.InputJsonValue, purgedAt: now },
      });
      purged += updated.count;
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(`Purge IA : ${purged} identification(s) purgée(s), ${failed} échec(s) S3.`);
    }
    return { purged, failed };
  }
}
