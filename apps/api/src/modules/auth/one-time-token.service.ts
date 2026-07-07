import { Injectable } from '@nestjs/common';
import { type OneTimeToken, type OneTimeTokenPurpose } from '@prisma/client';
import { PrismaService } from '../../database';
import { type RequestContext } from './token.service';
import { generateOpaqueToken, sha256Hex } from './crypto.util';

/** Durées de vie par finalité (documentées dans docs/auth.md). */
export const ONE_TIME_TOKEN_TTL_MS: Record<OneTimeTokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 3600_000, // 24 h
  PASSWORD_RESET: 30 * 60_000, // 30 min
  MFA_CHALLENGE: 5 * 60_000, // 5 min
  ACCOUNT_DELETION: 30 * 60_000, // 30 min
  ADMIN_INVITATION: 7 * 24 * 3600_000, // 7 jours (tâche 09)
};

/**
 * Jetons à usage unique (vérification de courriel, réinitialisation,
 * défi MFA, suppression de compte) : 256 bits aléatoires, hachés en base,
 * expiration courte, consommation ATOMIQUE (au plus un gagnant même sous
 * requêtes concurrentes).
 */
@Injectable()
export class OneTimeTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Émet un jeton et invalide les précédents de même finalité (un seul
   * lien valide à la fois : le dernier courriel envoyé fait foi).
   */
  async issue(
    userId: string,
    purpose: OneTimeTokenPurpose,
    ctx: RequestContext,
  ): Promise<{ raw: string; expiresAt: Date }> {
    const raw = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + ONE_TIME_TOKEN_TTL_MS[purpose]);
    await this.prisma.$transaction([
      this.prisma.oneTimeToken.updateMany({
        where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
        data: { expiresAt: new Date() },
      }),
      this.prisma.oneTimeToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256Hex(raw),
          expiresAt,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ]);
    return { raw, expiresAt };
  }

  /** Jeton encore valide, SANS le consommer (défi MFA multi-essais). */
  async peek(raw: string, purpose: OneTimeTokenPurpose): Promise<OneTimeToken | null> {
    return this.prisma.oneTimeToken.findFirst({
      where: {
        tokenHash: sha256Hex(raw),
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Consomme un jeton : retourne la ligne si CE processus a gagné la
   * course (UPDATE conditionnel), null si jeton inconnu/expiré/déjà usé.
   */
  async consume(raw: string, purpose: OneTimeTokenPurpose): Promise<OneTimeToken | null> {
    const token = await this.peek(raw, purpose);
    if (!token) return null;
    return this.consumeById(token.id);
  }

  /** Variante quand la ligne est déjà connue (après `peek`). */
  async consumeById(id: string): Promise<OneTimeToken | null> {
    const claimed = await this.prisma.oneTimeToken.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    return this.prisma.oneTimeToken.findUnique({ where: { id } });
  }

  /** Invalide tous les jetons en cours d'une finalité (ex. après réinitialisation). */
  async invalidateAll(userId: string, purpose: OneTimeTokenPurpose): Promise<void> {
    await this.prisma.oneTimeToken.updateMany({
      where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });
  }
}
