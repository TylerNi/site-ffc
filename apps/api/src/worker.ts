import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module';
import { type Env } from './config/env';
import { MAIL_QUEUE, type MailJob } from './modules/mail/mail-queue.service';
import { MailService } from './modules/mail/mail.service';
import { INVOICES_QUEUE } from './modules/orders/invoices/invoice-queue.service';
import { InvoiceService } from './modules/orders/invoices/invoice.service';
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

  const workers: Worker[] = [];
  if (redisUrl) {
    const connection = redisConnectionFromUrl(redisUrl);
    const processor = app.get(StripeWebhookProcessorService);
    const invoices = app.get(InvoiceService);
    const mail = app.get(MailService);

    const webhookWorker = new Worker<{ webhookEventId: string }>(
      STRIPE_WEBHOOKS_QUEUE,
      async (job) => processor.process(job.data.webhookEventId),
      { connection, concurrency: 4 },
    );
    webhookWorker.on('failed', (job, error) => {
      console.error(
        `[workers] Webhook ${job?.data?.webhookEventId ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    // Génération des factures PDF (tâche 12) — enchaîne le courriel de confirmation.
    const invoiceWorker = new Worker<{ orderId: string }>(
      INVOICES_QUEUE,
      async (job) => {
        await invoices.generateForOrder(job.data.orderId);
      },
      { connection, concurrency: 2 },
    );
    invoiceWorker.on('failed', (job, error) => {
      console.error(
        `[workers] Facture (commande ${job?.data?.orderId ?? '?'}) en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    // Courriels transactionnels (tâche 12) — retries + trace idempotente.
    const mailWorker = new Worker<MailJob>(
      MAIL_QUEUE,
      async (job) => {
        await mail.send(job.data);
      },
      { connection, concurrency: 4 },
    );
    mailWorker.on('failed', (job, error) => {
      console.error(
        `[workers] Courriel ${job?.data?.templateKey ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    workers.push(webhookWorker, invoiceWorker, mailWorker);
    console.log(
      `[workers] Files consommées (Redis) : ${STRIPE_WEBHOOKS_QUEUE}, ${INVOICES_QUEUE}, ${MAIL_QUEUE}.`,
    );
  } else {
    console.warn(
      '[workers] REDIS_URL absente — aucune file à consommer (les effets sont traités par l’API elle-même).',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[workers] Signal ${signal} reçu — arrêt en cours…`);
    await Promise.all(workers.map((worker) => worker.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[workers] Contexte worker démarré.');
}

void bootstrap();
