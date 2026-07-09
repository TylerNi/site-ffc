import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnectionFromUrl } from '../../../config/bullmq';
import { type Env } from '../../../config/env';
import { ShipstationShipmentsService } from './shipstation-shipments.service';
import { ShipstationSyncService } from './shipstation-sync.service';
import { ShipstationWebhookProcessorService } from './shipstation-webhook-processor.service';

/** File BullMQ ShipStation (producteur ici, worker.ts consomme). */
export const SHIPSTATION_QUEUE = 'shipstation';

/** Noms de travaux de la file. */
export const SHIPSTATION_JOBS = {
  /** Traite un webhook reçu (une ligne webhook_events). */
  webhook: 'webhook',
  /** Draine la boîte d'envoi des commandes payées. */
  drain: 'drain',
  /** Polling de repli des expéditions (webhook perdu). */
  poll: 'poll',
} as const;

/**
 * Cadence du drain : une commande payée est visible dans ShipStation en
 * quelques secondes (le critère d'acceptation demande « moins d'une minute »).
 */
export const DRAIN_INTERVAL_MS = 15_000;

/** Cadence du polling de repli des expéditions. */
export const POLL_INTERVAL_MS = 10 * 60_000;

/**
 * Producteur de la file ShipStation, et ORDONNANCEUR DE SECOURS en
 * développement.
 *
 * Avec REDIS_URL : les webhooks deviennent des jobs (`jobId` = id de la
 * ligne webhook_events — un rejeu ne crée pas de second job) ; le drain et
 * le polling sont des jobs répétables enregistrés par le service workers.
 *
 * Sans REDIS_URL (dev sans Docker) : les webhooks sont traités dans le
 * processus API, et une minuterie y draine la boîte d'envoi. En test, aucune
 * minuterie : les suites appellent `drain()` explicitement (déterminisme).
 * L'idempotence ne dépend JAMAIS de la file.
 */
@Injectable()
export class ShipstationQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ShipstationQueueService.name);
  private readonly queue: Queue | null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly processor: ShipstationWebhookProcessorService,
    private readonly sync: ShipstationSyncService,
    private readonly shipments: ShipstationShipmentsService,
  ) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    this.queue = redisUrl
      ? new Queue(SHIPSTATION_QUEUE, {
          connection: redisConnectionFromUrl(redisUrl),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 24 * 3_600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
        })
      : null;
  }

  async enqueueWebhook(webhookEventId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add(
        SHIPSTATION_JOBS.webhook,
        { webhookEventId },
        { jobId: `shipstation-webhook:${webhookEventId}` },
      );
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      // Déterministe : l'expédition est ingérée avant la réponse HTTP.
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

  /* --------------------- Ordonnanceur de secours (dev) -------------------- */

  onApplicationBootstrap(): void {
    const hasRedis = Boolean(this.config.get('REDIS_URL', { infer: true }));
    if (hasRedis || process.env.NODE_ENV === 'test') return;

    this.logger.warn(
      'REDIS_URL absente — drain ShipStation et polling de repli tournent dans le processus API (dev seulement).',
    );
    this.timers.push(
      setInterval(() => {
        void this.sync.drain().catch((error) => this.logger.error('Drain ShipStation', error));
      }, DRAIN_INTERVAL_MS),
      setInterval(() => {
        void this.shipments
          .pollRecentShipments()
          .catch((error) => this.logger.error('Polling ShipStation', error));
      }, POLL_INTERVAL_MS),
    );
    this.timers.forEach((timer) => timer.unref());
  }

  async onApplicationShutdown(): Promise<void> {
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    await this.queue?.close();
  }
}
