import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { type RefreshToken, type User, type UserRole } from '@prisma/client';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { generateOpaqueToken, sha256Hex } from './crypto.util';

/** Contexte réseau de la requête, consigné avec chaque jeton. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** Claims de l'access token — le strict nécessaire (brief tâche 05). */
export interface AccessTokenClaims {
  /** Id utilisateur. */
  sub: string;
  /** Rôle système grossier (le RBAC fin reste en base). */
  role: UserRole;
  /** Id de session = famille de refresh tokens (liste/révocation de sessions). */
  sid: string;
  iat: number;
  exp: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Durée de vie de l'access token, en secondes. */
  expiresIn: number;
  /** Famille de refresh tokens créée ou poursuivie (= id de session). */
  familyId: string;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * Jetons de session (tâche 05).
 *
 * Access token : JWT HS256 de 15 minutes — jamais stocké côté serveur.
 * Refresh token : opaque (256 bits), haché SHA-256 en base, À ROTATION
 * OBLIGATOIRE : chaque rafraîchissement marque l'ancien jeton « usé » et en
 * émet un nouveau dans la même famille (`family_id` = session/appareil).
 *
 * Détection de réutilisation : présenter un jeton déjà usé ou révoqué est
 * le signe qu'il a été volé (le client légitime détient déjà son
 * successeur) → TOUTE la famille est révoquée et l'événement audité.
 */
@Injectable()
export class TokenService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  /* ------------------------------ Émission ----------------------------- */

  /** Ouvre une nouvelle session (login) : nouvelle famille de refresh tokens. */
  async issueSession(user: User, ctx: RequestContext): Promise<IssuedTokens> {
    const refreshToken = generateOpaqueToken();
    const record = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    return {
      accessToken: await this.signAccessToken(user, record.familyId),
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      familyId: record.familyId,
    };
  }

  private async signAccessToken(user: User, familyId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, role: user.role, sid: familyId },
      { expiresIn: this.accessTtlSeconds },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token);
  }

  /* ------------------------------ Rotation ----------------------------- */

  /**
   * Rotation d'un refresh token. Lance UnauthorizedException (message
   * neutre) pour tout jeton inconnu, expiré, révoqué… et révoque la famille
   * entière en cas de réutilisation détectée.
   */
  async rotate(rawToken: string, ctx: RequestContext): Promise<IssuedTokens & { user: User }> {
    const tokenHash = sha256Hex(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!existing) throw new UnauthorizedException('Session invalide ou expirée.');

    if (existing.usedAt || existing.revokedAt) {
      // RÉUTILISATION : le jeton a déjà servi (ou la session est révoquée).
      // Vol probable → on brûle toute la lignée.
      await this.revokeFamily(existing.familyId);
      await this.audit.log({
        action: 'auth.refresh.reuse_detected',
        actorType: 'system',
        actorId: existing.userId,
        entityType: 'refresh_token_family',
        entityId: existing.familyId,
        metadata: { tokenId: existing.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    if (existing.expiresAt <= new Date() || existing.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    const refreshToken = generateOpaqueToken();
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Garde de concurrence : un seul appel peut « user » un jeton donné.
      const marked = await tx.refreshToken.updateMany({
        where: { id: existing.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (marked.count !== 1) return null;
      return tx.refreshToken.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId,
          tokenHash: sha256Hex(refreshToken),
          expiresAt: new Date(Date.now() + this.refreshTtlMs),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
    });

    if (!rotated) {
      // Course perdue : quelqu'un d'autre vient d'utiliser ce jeton.
      await this.revokeFamily(existing.familyId);
      await this.audit.log({
        action: 'auth.refresh.reuse_detected',
        actorType: 'system',
        actorId: existing.userId,
        entityType: 'refresh_token_family',
        entityId: existing.familyId,
        metadata: { tokenId: existing.id, race: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Session invalide ou expirée.');
    }

    return {
      accessToken: await this.signAccessToken(existing.user, existing.familyId),
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      familyId: existing.familyId,
      user: existing.user,
    };
  }

  /* ----------------------------- Révocation ---------------------------- */

  async revokeFamily(familyId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Révoque toutes les sessions d'un compte (sauf `exceptFamilyId` s'il est fourni). */
  async revokeAllForUser(userId: string, exceptFamilyId?: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Retrouve la famille d'un refresh token présenté (déconnexion). */
  async findFamilyByRawToken(rawToken: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
  }

  /* ------------------------------ Sessions ----------------------------- */

  /**
   * Sessions actives = familles ayant un jeton « courant » (ni usé, ni
   * révoqué, ni expiré). Le jeton courant porte l'activité la plus récente.
   */
  async listSessions(userId: string, currentFamilyId: string): Promise<SessionSummary[]> {
    const liveTokens = await this.prisma.refreshToken.findMany({
      where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
    if (liveTokens.length === 0) return [];

    const firstSeenByFamily = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: liveTokens.map((token) => token.familyId) } },
      _min: { createdAt: true },
    });
    const firstSeen = new Map(
      firstSeenByFamily.map((row) => [row.familyId, row._min.createdAt ?? new Date()]),
    );

    return liveTokens.map((token) => ({
      id: token.familyId,
      createdAt: firstSeen.get(token.familyId) ?? token.createdAt,
      lastActiveAt: token.createdAt,
      ip: token.ip,
      userAgent: token.userAgent,
      current: token.familyId === currentFamilyId,
    }));
  }

  /**
   * L'appareil est-il déjà connu ? (heuristique nouvel-appareil : même
   * user-agent déjà vu dans l'historique des sessions du compte).
   */
  async isKnownDevice(userId: string, userAgent: string | null, before: Date): Promise<boolean> {
    if (!userAgent) return false;
    const seen = await this.prisma.refreshToken.findFirst({
      where: { userId, userAgent, createdAt: { lt: before } },
      select: { id: true },
    });
    return seen !== null;
  }
}
