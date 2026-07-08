import { Injectable, Logger } from '@nestjs/common';
import { type ShippingCountry } from '@ffc/core';
import { PrismaService } from '../../../database';

/**
 * Clé de réglage des frais fixes vers les États-Unis (cents CAD).
 * Modifiable en admin (tâche 22) sans redéploiement — réplique de la
 * logique Zonos actuelle : un forfait unique, pas de calcul transporteur.
 */
export const US_FLAT_FEE_SETTING_KEY = 'expedition.frais_fixes_us_cents';

/** Valeur de repli si le réglage est absent ou illisible. */
export const US_FLAT_FEE_DEFAULT_CENTS = 2500;

/**
 * Règles de livraison v1 (décision arrêtée du brief, section 5.5 du plan) :
 * Canada GRATUIT partout ; États-Unis = frais FIXES configurables dans
 * `settings`. Tout autre pays est refusé en amont (schéma d'adresse).
 */
@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async shippingCentsFor(country: ShippingCountry): Promise<number> {
    if (country === 'CA') return 0;
    return this.usFlatFeeCents();
  }

  async usFlatFeeCents(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: US_FLAT_FEE_SETTING_KEY },
    });
    const value = setting?.value;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (setting) {
      this.logger.warn(
        `Réglage ${US_FLAT_FEE_SETTING_KEY} illisible (${JSON.stringify(value)}) — repli sur ${US_FLAT_FEE_DEFAULT_CENTS}`,
      );
    }
    return US_FLAT_FEE_DEFAULT_CENTS;
  }
}
