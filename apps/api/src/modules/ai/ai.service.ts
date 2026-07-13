import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type AiAnalysisMode, canonicalDimensionLabel, parseAiExtractionEnvelope } from '@ffc/core';
import { type AiIdentification, type EquipmentModel, type Prisma, type User } from '@prisma/client';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { AI_PHOTO_STORAGE, type AiPhotoStorage, MAX_AI_PHOTO_BYTES } from './ai-photo-storage';
import { AI_RETENTION_DAYS, AiSettingsService } from './ai-settings.service';
import { AiQueueService } from './ai-queue.service';
import { VISION_PROVIDER, type VisionProvider } from './ai-vision/vision-provider';
import {
  type AiIdentificationDto,
  type CreateAiIdentificationDto,
  type CreateAiIdentificationResponseDto,
} from './dto/ai.dto';
import { detectImageType, ImageDecodeError, sanitizeImage } from './image-content';

type RowWithModel = AiIdentification & { matchedEquipmentModel: EquipmentModel | null };

/**
 * Orchestration du flux d'identification par photo (tâche 17) :
 * création (consentement + quota + URL présignée) → soumission (validation
 * du CONTENU réel, assainissement EXIF, mise en file) → consultation (au
 * propriétaire seulement). Le traitement lui-même vit dans AiProcessorService.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiSettingsService,
    private readonly queue: AiQueueService,
    private readonly audit: AuditService,
    @Inject(AI_PHOTO_STORAGE) private readonly storage: AiPhotoStorage,
    @Inject(VISION_PROVIDER) private readonly provider: VisionProvider,
  ) {}

  async create(
    user: User,
    dto: CreateAiIdentificationDto,
    context: { ip: string | null; userAgent: string | null },
  ): Promise<CreateAiIdentificationResponseDto> {
    this.requireConfigured();
    await this.enforceDailyQuota(user.id);

    const upload = await this.storage.presignUpload(user.id);
    const purgeAt = new Date(Date.now() + AI_RETENTION_DAYS * 24 * 3_600_000);
    const row = await this.prisma.aiIdentification.create({
      data: {
        userId: user.id,
        imageKey: upload.key,
        status: 'PENDING',
        extraction: { mode: dto.mode } as Prisma.InputJsonValue,
        purgeAt,
      },
      include: { matchedEquipmentModel: true },
    });

    // Consentement explicite tracé dans le journal d'audit (Loi 25).
    await this.audit.log({
      actorType: 'user',
      actorId: user.id,
      actorEmail: user.email,
      action: 'ai.identification.creation',
      entityType: 'ai_identification',
      entityId: row.id,
      metadata: { mode: dto.mode, consent: true, retentionDays: AI_RETENTION_DAYS },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      identification: toDto(row),
      upload: {
        url: upload.url,
        fields: upload.fields,
        maxBytes: upload.maxBytes,
        expiresInSeconds: upload.expiresInSeconds,
      },
    };
  }

  async submit(user: User, id: string): Promise<AiIdentificationDto> {
    this.requireConfigured();
    const row = await this.ownedRow(user, id);
    if (row.status !== 'PENDING') {
      throw new ConflictException('Cette identification a déjà été soumise.');
    }

    const bytes = await this.storage.fetch(row.imageKey);
    if (!bytes) {
      throw new BadRequestException('Téléversez d’abord la photo via l’URL présignée.');
    }
    if (bytes.length > MAX_AI_PHOTO_BYTES) {
      throw new BadRequestException(
        `Photo trop volumineuse (${Math.round(bytes.length / 1024 / 1024)} Mo) — maximum 10 Mo.`,
      );
    }

    // CONTENU réel seulement — jamais l'extension ni le Content-Type déclaré.
    const detected = detectImageType(bytes);
    if (!detected) {
      throw new BadRequestException(
        'Le fichier téléversé n’est pas une image acceptée (JPEG, PNG, WebP ou HEIC).',
      );
    }

    // Ré-encodage sharp : EXIF (GPS !) retiré avant toute analyse.
    let sanitized;
    try {
      sanitized = await sanitizeImage(bytes);
    } catch (error) {
      if (error instanceof ImageDecodeError) {
        this.logger.warn(`Image indécodable (${detected}) : ${error.message}`);
        throw new BadRequestException(
          detected === 'image/heic'
            ? 'Photo HEIC non décodable sur ce serveur — convertissez-la en JPEG et recommencez.'
            : 'Image illisible ou corrompue — reprenez la photo et recommencez.',
        );
      }
      throw error;
    }
    await this.storage.put(row.imageKey, sanitized.data, 'image/jpeg');

    await this.queue.enqueueAnalysis(row.id);
    return toDto(await this.ownedRow(user, id));
  }

  async get(user: User, id: string): Promise<AiIdentificationDto> {
    return toDto(await this.ownedRow(user, id));
  }

  /** 404 (jamais 403) si l'identification n'existe pas OU appartient à un autre compte. */
  private async ownedRow(user: User, id: string): Promise<RowWithModel> {
    const row = await this.prisma.aiIdentification.findFirst({
      where: { id, userId: user.id },
      include: { matchedEquipmentModel: true },
    });
    if (!row) throw new NotFoundException('Identification introuvable.');
    return row;
  }

  /** Sans clé API du fournisseur choisi : 503 propre (pattern Stripe, tâche 11). */
  private requireConfigured(): void {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException(
        'Identification par photo indisponible : le fournisseur de vision n’est pas configuré sur ce serveur.',
      );
    }
  }

  /** Quota par utilisateur et par jour (UTC) — 429 avec message clair. */
  private async enforceDailyQuota(userId: string): Promise<void> {
    const quota = await this.settings.dailyQuota();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const used = await this.prisma.aiIdentification.count({
      where: { userId, createdAt: { gte: dayStart } },
    });
    if (used >= quota) {
      throw new HttpException(
        `Limite quotidienne atteinte (${quota} analyses par jour). Réessayez demain.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function toDto(row: RowWithModel): AiIdentificationDto {
  const envelope = parseAiExtractionEnvelope(row.extraction);
  const vision = envelope?.vision ?? null;

  return {
    id: row.id,
    mode: (envelope?.mode ?? 'FILTER_FRAME') satisfies AiAnalysisMode,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    failureReason: row.failureReason,
    result: vision
      ? {
          manufacturer: vision.manufacturer,
          modelNumber: vision.modelNumber,
          dimensions: {
            widthIn: vision.dimensions.widthIn,
            heightIn: vision.dimensions.heightIn,
            depthIn: vision.dimensions.depthIn,
            label:
              vision.dimensions.widthIn !== null && vision.dimensions.heightIn !== null
                ? canonicalDimensionLabel({
                    width: vision.dimensions.widthIn,
                    height: vision.dimensions.heightIn,
                    depth: vision.dimensions.depthIn,
                  })
                : null,
            confidence: vision.dimensions.confidence,
          },
          merv: vision.merv,
          readableText: vision.readableText,
          suggestedMode: vision.suggestedMode,
          notes: vision.notes,
        }
      : null,
    match: envelope?.match ?? null,
    matchedEquipmentModel: row.matchedEquipmentModel
      ? {
          id: row.matchedEquipmentModel.id,
          manufacturer: row.matchedEquipmentModel.manufacturer,
          modelNumber: row.matchedEquipmentModel.modelNumber,
        }
      : null,
    suggestedVariants: envelope?.variants ?? [],
    purgeAt: (row.purgeAt ?? row.createdAt).toISOString(),
    purgedAt: row.purgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
