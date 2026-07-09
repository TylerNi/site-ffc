import { type ConnectionOptions } from 'bullmq';

/**
 * Connexion Redis des files BullMQ — module FEUILLE (aucun import de service)
 * pour éviter les cycles : les producteurs (webhooks, factures, courriels)
 * l'importent tous sans se référencer mutuellement.
 *
 * `redis[s]://user:pass@host:port/db` → options de connexion BullMQ.
 */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // Requis par BullMQ : pas de plafond de retentatives sur les commandes bloquantes.
    maxRetriesPerRequest: null,
  };
}
