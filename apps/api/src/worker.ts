import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { type Env } from './config/env';
import { StripeWebhookProcessorService } from './modules/orders/webhooks/stripe-webhook-processor.service';
import {
  redisConnectionFromUrl,
  STRIPE_WEBHOOKS_QUEUE,
} from './modules/orders/webhooks/webhook-queue.service';

/**
 * Point d'entrée du service « workers » (ECS Fargate).
 *
 * Même image que l'API, commande différente (`node dist/worker.js`). Démarre
 * un contexte Nest autonome, *sans* serveur HTTP, qui consomme les files
 * BullMQ. Files actives :
 *   - stripe-webhooks (tâche 11) : traitement idempotent des événements
 *     Stripe, retentatives exponentielles (les échecs restent visibles en
 *     base via webhook_events.status = FAILED).
 * (Suivi de colis et rappels arrivent aux tâches 14 et 20.)
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const redisUrl = config.get('REDIS_URL', { infer: true });

  let webhookWorker: Worker | null = null;
  if (redisUrl) {
    const processor = app.get(StripeWebhookProcessorService);
    webhookWorker = new Worker<{ webhookEventId: string }>(
      STRIPE_WEBHOOKS_QUEUE,
      async (job) => processor.process(job.data.webhookEventId),
      { connection: redisConnectionFromUrl(redisUrl), concurrency: 4 },
    );
    webhookWorker.on('failed', (job, error) => {
      console.error(
        `[workers] Webhook ${job?.data?.webhookEventId ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });
    console.log(`[workers] File « ${STRIPE_WEBHOOKS_QUEUE} » consommée (Redis).`);
  } else {
    console.warn(
      '[workers] REDIS_URL absente — aucune file à consommer (les webhooks sont traités par l’API elle-même).',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[workers] Signal ${signal} reçu — arrêt en cours…`);
    await webhookWorker?.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[workers] Contexte worker démarré.');
}

void bootstrap();
