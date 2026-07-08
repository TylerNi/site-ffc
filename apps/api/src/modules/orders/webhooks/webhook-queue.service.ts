import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { type Env } from '../../../config/env';
import { StripeWebhookProcessorService } from './stripe-webhook-processor.service';

/** Nom de la file BullMQ des webhooks Stripe (producteur ici, worker.ts consomme). */
export const STRIPE_WEBHOOKS_QUEUE = 'stripe-webhooks';

/** `redis[s]://user:pass@host:port/db` → options de connexion BullMQ. */
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

/**
 * Producteur de la file de webhooks (tâche 11).
 *
 * REDIS_URL présent : chaque événement reçu devient un job BullMQ
 * (`jobId` = id de la ligne webhook_events — un rejeu ne crée pas de
 * second job), consommé par le service workers (worker.ts), avec
 * retentatives exponentielles.
 *
 * REDIS_URL absent (dev sans Docker, tests) : traitement immédiat dans le
 * processus — en test, il est ATTENDU (déterminisme) ; en dev, détaché.
 * L'idempotence ne dépend JAMAIS de la file : elle est portée par la
 * table webhook_events et par la finalisation conditionnelle.
 */
@Injectable()
export class WebhookQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(WebhookQueueService.name);
  private readonly queue: Queue | null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly processor: StripeWebhookProcessorService,
  ) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    if (redisUrl) {
      this.queue = new Queue(STRIPE_WEBHOOKS_QUEUE, {
        connection: redisConnectionFromUrl(redisUrl),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      });
    } else {
      this.queue = null;
      this.logger.warn(
        'REDIS_URL absente — webhooks traités dans le processus API (dev/test seulement).',
      );
    }
  }

  async enqueue(webhookEventId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add('process', { webhookEventId }, { jobId: webhookEventId });
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      // Déterministe pour les tests : l'événement est traité avant la réponse.
      await this.processor.process(webhookEventId).catch((error) => {
        this.logger.error(`Traitement inline du webhook ${webhookEventId} en échec`, error);
      });
      return;
    }
    setImmediate(() => {
      this.processor.process(webhookEventId).catch((error) => {
        this.logger.error(`Traitement inline du webhook ${webhookEventId} en échec`, error);
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
