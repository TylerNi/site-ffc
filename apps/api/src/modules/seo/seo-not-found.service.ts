import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Vigie SEO post-bascule (tâche 25 §7) : la vitrine signale chaque 404 servi
 * après la bascule DNS; on agrège par (hôte, chemin, jour UTC) pour repérer
 * les URLs BigCommerce oubliées par la table de redirections et les corriger
 * par redéploiement de l'artefact — sans jamais stocker de donnée personnelle
 * (pas d'IP, pas de user-agent, referer tronqué).
 */

export const NOT_FOUND_PATH_MAX = 400;
export const NOT_FOUND_REFERER_MAX = 500;
/** Chemins DISTINCTS max par (hôte, jour) — borne les scans de bots. */
export const NOT_FOUND_DAILY_CAP = 5000;
/** Rétention avant purge opportuniste. */
export const NOT_FOUND_RETENTION_DAYS = 90;
const PURGE_PROBABILITY = 0.01;

export interface NotFoundHit {
  host: string;
  path: string;
  referer?: string | null;
}

export interface NotFoundPathReport {
  path: string;
  hits: number;
  lastReferer: string | null;
  lastSeenAt: string;
}

export interface NotFoundHostReport {
  host: string;
  totalHits: number;
  distinctPaths: number;
  top: NotFoundPathReport[];
}

export interface NotFoundReport {
  day: string;
  hosts: NotFoundHostReport[];
}

@Injectable()
export class SeoNotFoundService {
  constructor(private readonly prisma: PrismaService) {}

  /** Jour UTC (minuit) — la colonne `day` est un DATE Postgres. */
  static dayOf(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  /**
   * Incrémente le compteur du (hôte, chemin, jour). Silencieusement sans
   * effet si le plafond quotidien de chemins distincts est atteint : le
   * rapport reste lisible même sous un scan agressif.
   */
  async record(hit: NotFoundHit, now = new Date()): Promise<void> {
    const host = hit.host.trim().toLowerCase().slice(0, 255);
    const rawPath = hit.path.trim();
    if (!host || !rawPath) return;
    const path = (rawPath.startsWith('/') ? rawPath : `/${rawPath}`).slice(0, NOT_FOUND_PATH_MAX);
    const referer = hit.referer ? hit.referer.slice(0, NOT_FOUND_REFERER_MAX) : null;
    const day = SeoNotFoundService.dayOf(now);
    const where = { host_path_day: { host, path, day } };

    const existing = await this.prisma.storefrontNotFound.findUnique({
      where,
      select: { id: true },
    });
    if (!existing) {
      const distinct = await this.prisma.storefrontNotFound.count({ where: { host, day } });
      if (distinct >= NOT_FOUND_DAILY_CAP) return;
    }

    const update = {
      hits: { increment: 1 },
      lastSeenAt: now,
      ...(referer ? { lastReferer: referer } : {}),
    };
    try {
      await this.prisma.storefrontNotFound.upsert({
        where,
        create: { host, path, day, hits: 1, lastReferer: referer, lastSeenAt: now },
        update,
      });
    } catch (error) {
      // Deux premiers signalements simultanés du même chemin : l'un des deux
      // perd la course à l'insertion — on bascule en incrément.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.prisma.storefrontNotFound.update({ where, data: update });
      } else {
        throw error;
      }
    }

    if (Math.random() < PURGE_PROBABILITY) await this.purgeOldEntries(now);
  }

  /** Supprime les lignes plus vieilles que la rétention; retourne le compte. */
  async purgeOldEntries(now = new Date()): Promise<number> {
    const cutoff = SeoNotFoundService.dayOf(
      new Date(now.getTime() - NOT_FOUND_RETENTION_DAYS * 86_400_000),
    );
    const { count } = await this.prisma.storefrontNotFound.deleteMany({
      where: { day: { lt: cutoff } },
    });
    return count;
  }

  /** Rapport quotidien : par hôte, total de hits et top N des chemins. */
  async dailyReport(day: Date, limit: number): Promise<NotFoundReport> {
    const totals = await this.prisma.storefrontNotFound.groupBy({
      by: ['host'],
      where: { day },
      _sum: { hits: true },
      _count: { _all: true },
      orderBy: { host: 'asc' },
    });

    const hosts: NotFoundHostReport[] = [];
    for (const total of totals) {
      const top = await this.prisma.storefrontNotFound.findMany({
        where: { day, host: total.host },
        orderBy: [{ hits: 'desc' }, { path: 'asc' }],
        take: limit,
        select: { path: true, hits: true, lastReferer: true, lastSeenAt: true },
      });
      hosts.push({
        host: total.host,
        totalHits: total._sum.hits ?? 0,
        distinctPaths: total._count._all,
        top: top.map((row) => ({
          path: row.path,
          hits: row.hits,
          lastReferer: row.lastReferer,
          lastSeenAt: row.lastSeenAt.toISOString(),
        })),
      });
    }

    return { day: day.toISOString().slice(0, 10), hosts };
  }
}
