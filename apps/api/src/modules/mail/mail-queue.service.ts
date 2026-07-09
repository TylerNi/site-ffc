import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnectionFromUrl } from '../../config/bullmq';
import { type Env } from '../../config/env';
import { MailService, type SendMailParams } from './mail.service';

/** File BullMQ des courriels transactionnels (producteur ici, worker.ts consomme). */
export const MAIL_QUEUE = 'mail';

/** Payload de job : SendMailParams SANS variables secrètes (jamais en file). */
export type MailJob = Omit<SendMailParams, 'secretVariables'>;

/**
 * Producteur de la file de courriels transactionnels (tâche 12).
 *
 * Avec REDIS_URL : chaque courriel de commande/remboursement devient un job
 * BullMQ (retentatives exponentielles ; `jobId` = clé d'idempotence quand
 * elle existe, un rejeu ne crée pas de second job). Sans REDIS_URL (dev/test)
 * : envoi immédiat dans le processus — ATTENDU en test (déterminisme).
 *
 * L'idempotence ultime ne dépend jamais de la file : elle est portée par
 * `notifications.idempotency_key` (voir MailService.send).
 */
@Injectable()
export class MailQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(MailQueueService.name);
  private readonly queue: Queue | null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly mail: MailService,
  ) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    this.queue = redisUrl
      ? new Queue(MAIL_QUEUE, {
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

  async enqueue(job: MailJob): Promise<void> {
    if (this.queue) {
      await this.queue.add('send', job, job.idempotencyKey ? { jobId: job.idempotencyKey } : {});
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      // Déterministe : le courriel est envoyé avant le retour de l'appelant.
      await this.mail.send(job).catch((error) => {
        this.logger.error(`Envoi inline du courriel ${job.templateKey} en échec`, error);
      });
      return;
    }
    setImmediate(() => {
      this.mail.send(job).catch((error) => {
        this.logger.error(`Envoi inline du courriel ${job.templateKey} en échec`, error);
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
