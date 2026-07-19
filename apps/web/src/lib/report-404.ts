import { REDIRECTS_ENV_FLAG } from '@ffc/core';

/**
 * Vigie SEO post-bascule (tâche 25 §7) : signale à l'API chaque 404 servi
 * par la vitrine, pour repérer les URLs BigCommerce oubliées par la table de
 * redirections. Appelé dans `after()` (après l'envoi de la réponse) — jamais
 * sur le chemin critique.
 *
 * Best-effort assumé : timeout court, toute erreur avalée. Inactif tant que
 * l'interrupteur des redirections (`REDIRECTS_ENABLED=1`) n'est pas levé —
 * rien ne bouge avant la bascule, et aucun bruit en développement.
 */

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface NotFoundReportInput {
  host: string | null;
  path: string;
  referer?: string | null;
}

export async function reportStorefrontNotFound(input: NotFoundReportInput): Promise<void> {
  if (process.env[REDIRECTS_ENV_FLAG] !== '1') return;
  if (!input.host || !input.path) return;
  try {
    await fetch(`${API_URL}/v1/seo/not-found`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: input.host,
        path: input.path,
        ...(input.referer ? { referer: input.referer } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Vigie best-effort : un échec de signalement ne casse jamais la page.
  }
}
