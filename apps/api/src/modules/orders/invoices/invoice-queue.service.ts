import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnectionFromUrl } from '../../../config/bullmq';
import { type Env } from '../../../config/env';
import { InvoiceService } from './invoice.service';

/** File BullMQ de génération des factures PDF (producteur ici, worker.ts consomme). */
export const INVOICES_QUEUE = 'invoices';

/**
 * Producteur de la file de génération de factures (tâche 12).
 *
 * À la commande payée, la finalisation met un job ici (`jobId` = orderId :
 * un rejeu ne crée pas de second job). Le worker rend le PDF, le stocke, et
 * enchaîne le courriel de confirmation. Sans REDIS_URL : génération immédiate
 * dans le processus (awaited en test — déterminisme). L'idempotence est
 * portée par l'index unique de la facture, jamais par la file.
 */
@Injectable()
export class InvoiceQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(InvoiceQueueService.name);
  private readonly queue: Queue | null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly invoices: InvoiceService,
  ) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    this.queue = redisUrl
      ? new Queue(INVOICES_QUEUE, {
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

  async enqueueGeneration(orderId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add('generate', { orderId }, { jobId: `invoice:${orderId}` });
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      await this.invoices.generateForOrder(orderId).catch((error) => {
        this.logger.error(`Génération inline de la facture (commande ${orderId}) en échec`, error);
      });
      return;
    }
    setImmediate(() => {
      this.invoices.generateForOrder(orderId).catch((error) => {
        this.logger.error(`Génération inline de la facture (commande ${orderId}) en échec`, error);
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
