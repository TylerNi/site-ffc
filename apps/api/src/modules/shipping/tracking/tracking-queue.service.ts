import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../../../config/env';
import { TrackingPollerService } from './tracking-poller.service';

/** File BullMQ du repérage (producteur ici, worker.ts consomme). */
export const TRACKING_QUEUE = 'tracking';

export const TRACKING_JOBS = {
  /** Un passage de scan : réclame les colis dus et les repère. */
  scan: 'scan',
} as const;

/**
 * Cadence du SCAN (pas du repérage d'un colis !) : le scan ramasse les
 * colis dont `next_poll_at` est échu — c'est cette colonne qui porte la
 * cadence adaptative (6 h / 1 h / arrêt). Un scan sans colis dû ne coûte
 * qu'une requête SQL.
 */
export const TRACKING_SCAN_INTERVAL_MS = 5 * 60_000;

/**
 * Ordonnanceur du polling de repérage (tâche 14).
 *
 * Avec REDIS_URL : le worker (worker.ts) consomme un job répétable `scan`.
 * Sans REDIS_URL (dev sans Docker) : une minuterie scanne dans le processus
 * API. En test : AUCUNE minuterie — les suites appellent `scan()`
 * explicitement (déterminisme, mêmes conventions que ShipStation).
 */
@Injectable()
export class TrackingQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TrackingQueueService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly poller: TrackingPollerService,
  ) {}

  onApplicationBootstrap(): void {
    const hasRedis = Boolean(this.config.get('REDIS_URL', { infer: true }));
    if (hasRedis || process.env.NODE_ENV === 'test') return;

    this.logger.warn(
      'REDIS_URL absente — le scan de repérage tourne dans le processus API (dev seulement).',
    );
    this.timer = setInterval(() => {
      void this.poller.scan().catch((error) => this.logger.error('Scan de repérage', error));
    }, TRACKING_SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
