import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnectionFromUrl } from '../../config/bullmq';
import { type Env } from '../../config/env';
import { AiProcessorService } from './ai-processor.service';
import { AiPurgeService } from './ai-purge.service';

/** File BullMQ du pipeline de vision (producteur ici, worker.ts consomme). */
export const AI_VISION_QUEUE = 'ai-vision';

export const AI_JOBS = {
  /** Analyse d'une identification soumise. */
  analyze: 'analyze',
  /** Purge quotidienne à 30 jours (Loi 25) — job répétable. */
  purge: 'purge',
} as const;

/** Retentatives d'analyse (erreurs transitoires du fournisseur). */
export const AI_ANALYZE_ATTEMPTS = 3;

/** Cadence du job répétable de purge. */
export const AI_PURGE_INTERVAL_MS = 24 * 3_600_000;

/**
 * Producteur de la file `ai-vision` (tâche 17).
 *
 * Avec REDIS_URL : chaque soumission devient un job (`jobId` = id de
 * l'identification — un doublon ne crée pas de second job) ; le worker
 * (worker.ts) consomme et le job répétable `purge` tourne chaque jour.
 * Sans REDIS_URL : traitement immédiat dans le processus — attendu en test
 * (déterminisme), différé en dev ; la purge tourne sur une minuterie locale.
 * L'idempotence ultime ne dépend jamais de la file : c'est la transition
 * PENDING → PROCESSING atomique du processeur qui la porte.
 */
@Injectable()
export class AiQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AiQueueService.name);
  private readonly queue: Queue | null;
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly processor: AiProcessorService,
    private readonly purge: AiPurgeService,
  ) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    this.queue = redisUrl
      ? new Queue(AI_VISION_QUEUE, {
          connection: redisConnectionFromUrl(redisUrl),
          defaultJobOptions: {
            attempts: AI_ANALYZE_ATTEMPTS,
            backoff: { type: 'exponential', delay: 15_000 },
            removeOnComplete: { age: 24 * 3_600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
        })
      : null;
  }

  async enqueueAnalysis(identificationId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add(
        AI_JOBS.analyze,
        { identificationId },
        { jobId: `ai:analyze:${identificationId}` },
      );
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      // Déterministe : l'analyse est terminée avant le retour de la soumission.
      await this.processor.process(identificationId, { finalAttempt: true }).catch((error) => {
        this.logger.error(`Analyse inline de ${identificationId} en échec`, error);
      });
      return;
    }
    setImmediate(() => {
      this.processor.process(identificationId, { finalAttempt: true }).catch((error) => {
        this.logger.error(`Analyse inline de ${identificationId} en échec`, error);
      });
    });
  }

  onApplicationBootstrap(): void {
    const hasRedis = Boolean(this.config.get('REDIS_URL', { infer: true }));
    if (hasRedis || process.env.NODE_ENV === 'test') return;

    // Dev sans Redis : purge quotidienne dans le processus API.
    this.logger.warn('REDIS_URL absente — purge IA sur minuterie locale (dev seulement).');
    this.purgeTimer = setInterval(() => {
      void this.purge.purgeDue().catch((error) => this.logger.error('Purge IA', error));
    }, AI_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
    await this.queue?.close();
  }
}
