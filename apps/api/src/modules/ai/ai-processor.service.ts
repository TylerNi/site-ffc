import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AiExtractionEnvelope,
  type AiMatchResult,
  type AiSuggestedVariant,
  parseAiExtractionEnvelope,
} from '@ffc/core';
import { type Prisma } from '@prisma/client';
import { PrismaService } from '../../database';
import { AI_PHOTO_STORAGE, type AiPhotoStorage } from './ai-photo-storage';
import { AiMatchingService } from './ai-matching.service';
import { AiSettingsService } from './ai-settings.service';
import {
  VISION_PROVIDER,
  type VisionAnalysis,
  type VisionProvider,
  VisionProviderError,
} from './ai-vision/vision-provider';

export type AiProcessOutcome = 'skipped' | 'completed' | 'needs_review' | 'failed';

/**
 * Traitement asynchrone d'une identification (file `ai-vision`, tâche 17).
 *
 * Transition PENDING → PROCESSING **atomique** (updateMany conditionnel) :
 * un job rejoué sur une identification déjà traitée (statut terminal) sort
 * immédiatement SANS rappeler le fournisseur — jamais de double facturation.
 * Un retry après échec transitoire (statut resté PROCESSING) repasse, lui :
 * l'appel précédent n'a rien produit.
 */
@Injectable()
export class AiProcessorService {
  private readonly logger = new Logger(AiProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: AiMatchingService,
    private readonly settings: AiSettingsService,
    @Inject(AI_PHOTO_STORAGE) private readonly storage: AiPhotoStorage,
    @Inject(VISION_PROVIDER) private readonly provider: VisionProvider,
  ) {}

  /**
   * `finalAttempt` : true quand BullMQ n'a plus de retentative (ou en mode
   * inline dev/test) — une erreur transitoire devient alors FAILED au lieu
   * d'être relancée.
   */
  async process(
    identificationId: string,
    options: { finalAttempt: boolean },
  ): Promise<AiProcessOutcome> {
    const claimed = await this.prisma.aiIdentification.updateMany({
      where: { id: identificationId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count === 0) {
      this.logger.log(
        `Identification ${identificationId} déjà traitée — job ignoré (idempotence).`,
      );
      return 'skipped';
    }

    const row = await this.prisma.aiIdentification.findUnique({ where: { id: identificationId } });
    if (!row) return 'skipped';

    const envelope = parseAiExtractionEnvelope(row.extraction);
    if (!envelope) {
      return this.fail(identificationId, 'Enveloppe d’extraction illisible (mode inconnu).');
    }

    const image = await this.storage.fetch(row.imageKey);
    if (!image) {
      return this.fail(identificationId, 'Image introuvable dans le stockage.');
    }

    let analysis: VisionAnalysis;
    try {
      analysis = await this.provider.analyze({
        image,
        mediaType: 'image/jpeg',
        mode: envelope.mode,
      });
    } catch (error) {
      if (error instanceof VisionProviderError && error.retryable && !options.finalAttempt) {
        // Statut laissé à PROCESSING : la retentative BullMQ pourra re-réclamer.
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      return this.fail(identificationId, reason, {
        provider: this.provider.name,
        model: this.provider.model,
      });
    }

    // Correspondance selon le mode.
    let match: AiMatchResult | undefined;
    let matchedEquipmentModelId: string | null = null;
    let variants: AiSuggestedVariant[] = [];
    if (envelope.mode === 'EQUIPMENT_LABEL') {
      const outcome = await this.matching.matchEquipment(
        analysis.extraction.manufacturer.value,
        analysis.extraction.modelNumber.value,
      );
      match = outcome.result;
      matchedEquipmentModelId = outcome.matchedEquipmentModelId;
      if (matchedEquipmentModelId) {
        variants = await this.matching.variantsForEquipmentModel(
          matchedEquipmentModelId,
          analysis.extraction.merv.value,
        );
      }
    } else {
      variants = await this.matching.matchVariantsByDimensions(
        analysis.extraction.dimensions,
        analysis.extraction.merv.value,
      );
    }

    // Seuil de confiance et bascule en file de révision.
    const threshold = await this.settings.confidenceThreshold();
    const confident = analysis.extraction.overallConfidence >= threshold;
    const cacheHit = match?.kind === 'exact' || match?.kind === 'alias';
    const hasCorrespondence =
      envelope.mode === 'EQUIPMENT_LABEL' ? matchedEquipmentModelId !== null : variants.length > 0;
    // Un numéro déjà résolu (equipment_models + alias) ne repasse JAMAIS en
    // révision : la table de correspondance fait office de cache.
    const completed = cacheHit || (confident && hasCorrespondence);

    const nextEnvelope: AiExtractionEnvelope = {
      mode: envelope.mode,
      vision: analysis.extraction,
      ...(match ? { match } : {}),
      ...(variants.length > 0 ? { variants } : {}),
    };

    await this.prisma.aiIdentification.update({
      where: { id: identificationId },
      data: {
        status: completed ? 'COMPLETED' : 'NEEDS_REVIEW',
        provider: analysis.provider,
        model: analysis.model,
        confidence: round3(analysis.extraction.overallConfidence),
        matchedEquipmentModelId,
        extraction: nextEnvelope as unknown as Prisma.InputJsonValue,
        failureReason: null,
      },
    });

    this.logger.log(
      `Identification ${identificationId} (${envelope.mode}) → ${completed ? 'COMPLETED' : 'NEEDS_REVIEW'} ` +
        `(confiance ${analysis.extraction.overallConfidence.toFixed(2)}, seuil ${threshold}).`,
    );
    return completed ? 'completed' : 'needs_review';
  }

  private async fail(
    identificationId: string,
    reason: string,
    providerInfo?: { provider: string; model: string },
  ): Promise<AiProcessOutcome> {
    await this.prisma.aiIdentification.update({
      where: { id: identificationId },
      data: {
        status: 'FAILED',
        failureReason: reason.slice(0, 500),
        ...(providerInfo ? { provider: providerInfo.provider, model: providerInfo.model } : {}),
      },
    });
    this.logger.warn(`Identification ${identificationId} en échec définitif : ${reason}`);
    return 'failed';
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
