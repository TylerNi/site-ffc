import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type User } from '@prisma/client';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { type RequestContext } from './token.service';

/**
 * Verrouillage progressif anti force brute (par compte).
 *
 * Paramètres (docs/auth.md) : les 4 premiers échecs consécutifs sont
 * libres; au 5e le compte se verrouille 1 minute, puis chaque échec
 * supplémentaire DOUBLE la durée (2, 4, 8… min) jusqu'au plafond de
 * 60 minutes. Une connexion réussie remet le compteur à zéro.
 *
 * Complémentaire au rate limiting par IP (@nestjs/throttler) : le
 * verrouillage par compte tient bon face à un attaquant distribué, et il
 * survit aux redémarrages puisqu'il vit en base.
 */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_MINUTES = 1;
export const LOCKOUT_MAX_MINUTES = 60;

/** 429 volontairement indistinguable du throttling par IP (anti-énumération). */
export class AccountLockedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super('Trop de tentatives. Réessayez plus tard.', HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfterSeconds = retryAfterSeconds;
  }
  readonly retryAfterSeconds: number;
}

@Injectable()
export class LockoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Lance AccountLockedException si le compte est actuellement verrouillé. */
  assertNotLocked(user: Pick<User, 'lockedUntil'>): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AccountLockedException(retryAfter);
    }
  }

  /** Enregistre un échec (mot de passe ou code MFA erroné) et verrouille au besoin. */
  async registerFailure(
    user: Pick<User, 'id' | 'email' | 'failedLoginCount'>,
    ctx: RequestContext,
    reason: 'password' | 'mfa',
  ): Promise<void> {
    const failedLoginCount = user.failedLoginCount + 1;
    let lockedUntil: Date | null = null;
    if (failedLoginCount >= LOCKOUT_THRESHOLD) {
      const exponent = failedLoginCount - LOCKOUT_THRESHOLD;
      const minutes = Math.min(LOCKOUT_BASE_MINUTES * 2 ** exponent, LOCKOUT_MAX_MINUTES);
      lockedUntil = new Date(Date.now() + minutes * 60_000);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount, lockedUntil },
    });

    await this.audit.log({
      action: 'auth.login.failed',
      actorType: 'system',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      metadata: { reason, failedLoginCount, lockedUntil: lockedUntil?.toISOString() ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /** Connexion réussie : remise à zéro du compteur et du verrou. */
  async reset(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }
}
