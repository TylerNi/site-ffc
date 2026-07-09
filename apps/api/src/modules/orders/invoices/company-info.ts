import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database';

/**
 * Coordonnées légales de l'entreprise affichées sur les factures et les
 * notes de crédit — lues depuis `settings['entreprise.facturation']`
 * (numéros d'inscription TPS/TVQ CONFIGURABLES, comme l'exige le brief).
 *
 * Des valeurs de repli existent pour ne jamais produire un document vide en
 * dev/test si le réglage manque ; en production le seed installe le réglage
 * et l'admin (tâche 22) le tiendra à jour.
 */

export interface CompanyAddress {
  line1: string;
  line2?: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export interface CompanyBillingInfo {
  raisonSociale: string;
  adresse: CompanyAddress;
  courriel: string;
  telephone: string | null;
  /** Numéro d'inscription TPS/TVH (format « 000000000 RT0001 »). */
  numeroTps: string;
  /** Numéro d'inscription TVQ (format « 0000000000 TQ0001 »). */
  numeroTvq: string;
}

export const SETTING_KEY_COMPANY_BILLING = 'entreprise.facturation';

/** Repli minimal (dev/test sans réglage seedé). */
const DEFAULT_COMPANY: CompanyBillingInfo = {
  raisonSociale: 'Filtration Montréal inc.',
  adresse: {
    line1: '1234, rue Sainte-Catherine Est',
    line2: 'Bureau 200',
    city: 'Montréal',
    province: 'QC',
    postalCode: 'H2L 2G8',
    country: 'CA',
  },
  courriel: 'facturation@filtrationmontreal.com',
  telephone: '+1 514-555-0142',
  numeroTps: '000000000 RT0001',
  numeroTvq: '0000000000 TQ0001',
};

@Injectable()
export class CompanyInfoService {
  constructor(private readonly prisma: PrismaService) {}

  async billing(): Promise<CompanyBillingInfo> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: SETTING_KEY_COMPANY_BILLING },
    });
    return mergeBilling(setting?.value);
  }
}

/** Fusionne le réglage (JSON partiel possible) avec les valeurs de repli. */
export function mergeBilling(value: unknown): CompanyBillingInfo {
  if (!value || typeof value !== 'object') return DEFAULT_COMPANY;
  const raw = value as Record<string, unknown>;
  const address =
    raw.adresse && typeof raw.adresse === 'object' ? (raw.adresse as Record<string, unknown>) : {};
  return {
    raisonSociale: str(raw.raisonSociale) ?? DEFAULT_COMPANY.raisonSociale,
    adresse: {
      line1: str(address.line1) ?? DEFAULT_COMPANY.adresse.line1,
      line2: str(address.line2) ?? DEFAULT_COMPANY.adresse.line2,
      city: str(address.city) ?? DEFAULT_COMPANY.adresse.city,
      province: str(address.province) ?? DEFAULT_COMPANY.adresse.province,
      postalCode: str(address.postalCode) ?? DEFAULT_COMPANY.adresse.postalCode,
      country: str(address.country) ?? DEFAULT_COMPANY.adresse.country,
    },
    courriel: str(raw.courriel) ?? DEFAULT_COMPANY.courriel,
    telephone: str(raw.telephone) ?? DEFAULT_COMPANY.telephone,
    numeroTps: str(raw.numeroTps) ?? DEFAULT_COMPANY.numeroTps,
    numeroTvq: str(raw.numeroTvq) ?? DEFAULT_COMPANY.numeroTvq,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
