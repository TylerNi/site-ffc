import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CookieOptions, type Request, type Response } from 'express';
import { type Env } from '../../config/env';

/** Nom du cookie httpOnly portant le refresh token (clients web). */
export const REFRESH_COOKIE_NAME = 'ffc_refresh';

/**
 * Cookie de refresh pour le web : httpOnly (inaccessible au JS), secure en
 * production, SameSite=Lax (le web et l'API partagent le même site
 * enregistrable — filtrationmontreal.com / api.filtrationmontreal.com),
 * Path restreint aux routes /v1/auth (le cookie ne voyage pas sur le
 * reste de l'API).
 *
 * Les clients mobiles ignorent le cookie et utilisent le refresh token du
 * corps de réponse, stocké dans le trousseau (Keychain/Keystore).
 */
@Injectable()
export class CookieService {
  private readonly secure: boolean;
  private readonly domain: string | undefined;
  private readonly maxAgeMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.secure = config.get('NODE_ENV', { infer: true }) === 'production';
    this.domain = config.get('AUTH_COOKIE_DOMAIN', { infer: true });
    this.maxAgeMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  private baseOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/v1/auth',
      ...(this.domain ? { domain: this.domain } : {}),
    };
  }

  /**
   * Pose le cookie de refresh. `maxAgeMsOverride` permet une durée plus
   * courte que le défaut (l'admin ouvre des sessions volontairement brèves,
   * tâche 09) : le jeton en base garde sa durée, mais le cookie — donc la
   * session web pratique — expire plus tôt.
   */
  setRefreshCookie(res: Response, refreshToken: string, maxAgeMsOverride?: number): void {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      ...this.baseOptions(),
      maxAge: maxAgeMsOverride ?? this.maxAgeMs,
    });
  }

  clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, this.baseOptions());
  }

  /** Refresh token présenté : corps de requête (mobile) sinon cookie (web). */
  refreshTokenFrom(req: Request, bodyToken: string | undefined): string | undefined {
    if (bodyToken) return bodyToken;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return cookies?.[REFRESH_COOKIE_NAME];
  }
}
