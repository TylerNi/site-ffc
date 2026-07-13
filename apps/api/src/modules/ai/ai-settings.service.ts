import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database';

/**
 * Réglages du pipeline IA — table `settings`, modifiables en admin sans
 * redéploiement (convention `expedition.frais_fixes_us_cents`, tâche 11).
 */
export const AI_CONFIDENCE_SETTING_KEY = 'ia.seuil_confiance';
export const AI_CONFIDENCE_DEFAULT = 0.85;

export const AI_DAILY_QUOTA_SETTING_KEY = 'ia.quota_quotidien';
export const AI_DAILY_QUOTA_DEFAULT = 10;

/** Rétention des photos et extractions (Loi 25) — alignée sur le cycle de vie S3. */
export const AI_RETENTION_DAYS = 30;

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seuil de confiance globale : au-dessus → COMPLETED, en dessous → NEEDS_REVIEW. */
  async confidenceThreshold(): Promise<number> {
    const value = await this.readNumber(AI_CONFIDENCE_SETTING_KEY);
    if (value !== null && value >= 0 && value <= 1) return value;
    return AI_CONFIDENCE_DEFAULT;
  }

  /** Quota d'analyses par utilisateur et par jour (UTC). */
  async dailyQuota(): Promise<number> {
    const value = await this.readNumber(AI_DAILY_QUOTA_SETTING_KEY);
    if (value !== null && Number.isInteger(value) && value >= 1) return value;
    return AI_DAILY_QUOTA_DEFAULT;
  }

  private async readNumber(key: string): Promise<number | null> {
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    if (!setting) return null;
    if (typeof setting.value === 'number' && Number.isFinite(setting.value)) return setting.value;
    this.logger.warn(
      `Réglage ${key} illisible (${JSON.stringify(setting.value)}) — repli sur le défaut.`,
    );
    return null;
  }
}
