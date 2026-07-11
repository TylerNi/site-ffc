import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../config/env';

/**
 * Revalidation ISR à la demande de la vitrine web (tâche 07/10) : la
 * publication/dépublication/archivage d'un produit dans l'admin doit être
 * visible en < 60 s SANS redéploiement. La vitrine expose
 * `POST /api/revalidate` (tâche 10, `apps/web/src/app/api/revalidate/route.ts`),
 * authentifié par un secret partagé (`REVALIDATE_SECRET`).
 *
 * Best effort : un échec réseau ne fait JAMAIS échouer la mutation admin —
 * les pages ISR se rafraîchissent de toute façon dans leur fenêtre normale
 * (tâche 07). Injectable pour être substitué par un faux en tests e2e.
 */
@Injectable()
export class RevalidationClient {
  private readonly logger = new Logger(RevalidationClient.name);
  private readonly webUrl: string;
  private readonly secret: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.webUrl = this.config.get('APP_WEB_URL', { infer: true });
    this.secret = this.config.get('REVALIDATE_SECRET', { infer: true });
  }

  async revalidate(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    try {
      const response = await fetch(`${this.webUrl}/api/revalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': this.secret },
        body: JSON.stringify({ tags }),
      });
      if (!response.ok) {
        this.logger.warn(
          `Revalidation ISR refusée (${response.status}) — tags : ${tags.join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Revalidation ISR injoignable (${this.webUrl}) — tags : ${tags.join(', ')}`,
        error,
      );
    }
  }
}
