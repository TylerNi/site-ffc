import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Ré-authentification « step-up » pour les actions sensibles admin (tâche 09).
 *
 * Après avoir prouvé un second facteur récent (code TOTP), le compte reçoit un
 * jeton court (5 min) qu'il joint aux requêtes sensibles via l'en-tête
 * `X-Step-Up-Token`. Mécanisme réutilisable : n'importe quelle route peut
 * l'exiger avec `@RequireStepUp()`.
 *
 * Le jeton est un JWT signé avec le même secret que l'access token mais une
 * AUDIENCE distincte : impossible de le présenter comme access token (et
 * réciproquement), donc pas de confusion de jetons. Il est lié au compte
 * (`sub`) ET à la session (`sid`) : inutilisable depuis une autre session.
 */
@Injectable()
export class StepUpService {
  private static readonly AUDIENCE = 'ffc-admin-step-up';
  private static readonly PURPOSE = 'admin_step_up';
  /** Durée de vie du jeton de step-up, en secondes. */
  static readonly TTL_SECONDS = 300;

  constructor(private readonly jwt: JwtService) {}

  async issue(userId: string, sessionId: string): Promise<{ token: string; expiresIn: number }> {
    const token = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, purpose: StepUpService.PURPOSE },
      { audience: StepUpService.AUDIENCE, expiresIn: StepUpService.TTL_SECONDS },
    );
    return { token, expiresIn: StepUpService.TTL_SECONDS };
  }

  /** Le jeton est-il valide POUR ce compte et cette session ? */
  async verify(token: string, userId: string, sessionId: string): Promise<boolean> {
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; sid: string; purpose: string }>(
        token,
        { audience: StepUpService.AUDIENCE },
      );
      return (
        claims.purpose === StepUpService.PURPOSE &&
        claims.sub === userId &&
        claims.sid === sessionId
      );
    } catch {
      return false;
    }
  }
}
