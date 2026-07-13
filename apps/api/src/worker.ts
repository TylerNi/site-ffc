import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { AppModule } from './app.module';
import { redisConnectionFromUrl } from './config/bullmq';
import { type Env } from './config/env';
import { AiProcessorService } from './modules/ai/ai-processor.service';
import { AiPurgeService } from './modules/ai/ai-purge.service';
import { AI_JOBS, AI_PURGE_INTERVAL_MS, AI_VISION_QUEUE } from './modules/ai/ai-queue.service';
import { MAIL_QUEUE, type MailJob } from './modules/mail/mail-queue.service';
import { MailService } from './modules/mail/mail.service';
import { INVOICES_QUEUE } from './modules/orders/invoices/invoice-queue.service';
import { InvoiceService } from './modules/orders/invoices/invoice.service';
import { StripeWebhookProcessorService } from './modules/orders/webhooks/stripe-webhook-processor.service';
import { STRIPE_WEBHOOKS_QUEUE } from './modules/orders/webhooks/webhook-queue.service';
import {
  DRAIN_INTERVAL_MS,
  POLL_INTERVAL_MS,
  SHIPSTATION_JOBS,
  SHIPSTATION_QUEUE,
} from './modules/shipping/shipstation/shipstation-queue.service';
import { ShipstationShipmentsService } from './modules/shipping/shipstation/shipstation-shipments.service';
import { ShipstationSyncService } from './modules/shipping/shipstation/shipstation-sync.service';
import { ShipstationWebhookProcessorService } from './modules/shipping/shipstation/shipstation-webhook-processor.service';
import {
  TRACKING_JOBS,
  TRACKING_QUEUE,
  TRACKING_SCAN_INTERVAL_MS,
} from './modules/shipping/tracking/tracking-queue.service';
import { TrackingPollerService } from './modules/shipping/tracking/tracking-poller.service';

/**
 * Point d'entrée du service « workers » (ECS Fargate).
 *
 * Même image que l'API, commande différente (`node dist/worker.js`). Démarre
 * un contexte Nest autonome, *sans* serveur HTTP, qui consomme les files
 * BullMQ. Files actives :
 *   - stripe-webhooks (tâche 11) : traitement idempotent des événements
 *     Stripe, retentatives exponentielles (les échecs restent visibles en
 *     base via webhook_events.status = FAILED) ;
 *   - invoices, mail (tâche 12) ;
 *   - shipstation (tâche 13) : webhooks à la demande, plus DEUX travaux
 *     répétables — le drain de la boîte d'envoi (commandes payées) et le
 *     polling de repli des expéditions (webhook perdu) ;
 *   - tracking (tâche 14) : scan répétable du polling de repérage — la
 *     cadence PAR COLIS (6 h / 1 h / arrêt) vit dans shipments.next_poll_at,
 *     l'isolation par transporteur dans le poller lui-même ;
 *   - ai-vision (tâche 17) : analyses d'identification par photo (transition
 *     PENDING → PROCESSING atomique — jamais de double appel fournisseur)
 *     plus le job répétable de purge quotidienne à 30 jours (Loi 25).
 * (Rappels de réachat : tâche 20.)
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

    // ShipStation (tâche 13). Concurrence 1 : l'API ShipStation est limitée
    // à 40 requêtes/minute et le client sérialise déjà ses appels.
    const shipstationSync = app.get(ShipstationSyncService);
    const shipstationShipments = app.get(ShipstationShipmentsService);
    const shipstationWebhooks = app.get(ShipstationWebhookProcessorService);

    const shipstationWorker = new Worker<{ webhookEventId?: string }>(
      SHIPSTATION_QUEUE,
      async (job) => {
        switch (job.name) {
          case SHIPSTATION_JOBS.webhook:
            await shipstationWebhooks.process(job.data.webhookEventId!);
            return;
          case SHIPSTATION_JOBS.drain:
            await shipstationSync.drain();
            return;
          case SHIPSTATION_JOBS.poll:
            await shipstationShipments.pollRecentShipments();
            return;
          default:
            console.warn(`[workers] Travail ShipStation inconnu : ${job.name}`);
        }
      },
      { connection, concurrency: 1 },
    );
    shipstationWorker.on('failed', (job, error) => {
      console.error(
        `[workers] ShipStation ${job?.name ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    // Suivi de colis (tâche 14). Concurrence 1 : le scan est single-flight
    // et le throttling par transporteur vit dans TrackingHttp.
    const trackingPoller = app.get(TrackingPollerService);
    const trackingWorker = new Worker(
      TRACKING_QUEUE,
      async (job) => {
        if (job.name === TRACKING_JOBS.scan) {
          await trackingPoller.scan();
          return;
        }
        console.warn(`[workers] Travail de repérage inconnu : ${job.name}`);
      },
      { connection, concurrency: 1 },
    );
    trackingWorker.on('failed', (job, error) => {
      console.error(
        `[workers] Repérage ${job?.name ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    // Pipeline de vision IA (tâche 17). Concurrence 2 : les analyses sont
    // indépendantes ; les limites de débit vivent chez le fournisseur (SDK).
    const aiProcessor = app.get(AiProcessorService);
    const aiPurge = app.get(AiPurgeService);
    const aiWorker = new Worker<{ identificationId?: string }>(
      AI_VISION_QUEUE,
      async (job) => {
        switch (job.name) {
          case AI_JOBS.analyze: {
            // BullMQ 5 : attemptsMade est 0-based PENDANT le traitement
            // (retentative si attemptsMade + 1 < attempts) — au dernier
            // essai, le processeur transforme l'erreur transitoire en FAILED.
            const attempts = job.opts.attempts ?? 1;
            const finalAttempt = job.attemptsMade + 1 >= attempts;
            await aiProcessor.process(job.data.identificationId!, { finalAttempt });
            return;
          }
          case AI_JOBS.purge:
            await aiPurge.purgeDue();
            return;
          default:
            console.warn(`[workers] Travail IA inconnu : ${job.name}`);
        }
      },
      { connection, concurrency: 2 },
    );
    aiWorker.on('failed', (job, error) => {
      console.error(
        `[workers] IA ${job?.name ?? '?'} (${job?.data?.identificationId ?? '—'}) en échec (tentative ${job?.attemptsMade ?? '?'})`,
        error.message,
      );
    });

    // Travaux répétables : ré-enregistrés à chaque démarrage (idempotent).
    const shipstationQueue = new Queue(SHIPSTATION_QUEUE, { connection });
    await shipstationQueue.upsertJobScheduler(
      'shipstation-drain',
      { every: DRAIN_INTERVAL_MS },
      { name: SHIPSTATION_JOBS.drain, opts: { attempts: 1, removeOnComplete: { count: 50 } } },
    );
    await shipstationQueue.upsertJobScheduler(
      'shipstation-poll',
      { every: POLL_INTERVAL_MS },
      { name: SHIPSTATION_JOBS.poll, opts: { attempts: 1, removeOnComplete: { count: 50 } } },
    );
    await shipstationQueue.close();

    const trackingQueue = new Queue(TRACKING_QUEUE, { connection });
    await trackingQueue.upsertJobScheduler(
      'tracking-scan',
      { every: TRACKING_SCAN_INTERVAL_MS },
      { name: TRACKING_JOBS.scan, opts: { attempts: 1, removeOnComplete: { count: 50 } } },
    );
    await trackingQueue.close();

    // Purge quotidienne des photos et extractions IA (Loi 25, tâche 17).
    const aiQueue = new Queue(AI_VISION_QUEUE, { connection });
    await aiQueue.upsertJobScheduler(
      'ai-purge',
      { every: AI_PURGE_INTERVAL_MS },
      { name: AI_JOBS.purge, opts: { attempts: 1, removeOnComplete: { count: 50 } } },
    );
    await aiQueue.close();

    workers.push(
      webhookWorker,
      invoiceWorker,
      mailWorker,
      shipstationWorker,
      trackingWorker,
      aiWorker,
    );
    console.log(
      `[workers] Files consommées (Redis) : ${STRIPE_WEBHOOKS_QUEUE}, ${INVOICES_QUEUE}, ${MAIL_QUEUE}, ${SHIPSTATION_QUEUE}, ${TRACKING_QUEUE}, ${AI_VISION_QUEUE}.`,
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
