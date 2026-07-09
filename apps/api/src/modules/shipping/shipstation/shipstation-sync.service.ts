import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Order, type OrderItem, type ShipstationSync } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { type Env } from '../../../config/env';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import {
  OrderLifecycleService,
  type TransitionActor,
} from '../../orders/lifecycle/order-lifecycle.service';
import { ShipstationClient, ShipstationError } from './shipstation.client';
import {
  buildOrderPayload,
  type MappedOrder,
  type OrderAddressSnapshot,
} from './shipstation-mapper';
import {
  backoffDelayMs,
  hasShipstationLabel,
  requestShipstationCancellation,
  SHIPSTATION_LEASE_MS,
  SHIPSTATION_MAX_ATTEMPTS,
} from './shipstation-outbox';

/** Nombre de lignes traitées par passage du drain (borne le débit). */
const DRAIN_BATCH_SIZE = 25;

/**
 * Statuts pour lesquels il n'y a plus rien à expédier. `REFUNDED` compte :
 * une commande intégralement remboursée avant l'étiquette (remboursement
 * admin, sans passer par l'annulation) ne doit jamais atteindre l'équipe
 * d'expédition.
 */
const NOT_TO_PUSH = ['CANCELLED', 'REFUNDED'] as const;

/** Cause consignée quand l'étiquette a été créée avant l'annulation. */
export const LABEL_ALREADY_CREATED_CAUSE =
  'Étiquette déjà créée dans ShipStation — annulation automatique bloquée, ' +
  'retrait manuel requis (voir docs/shipstation.md).';

export interface DrainReport {
  processed: number;
  synced: number;
  cancelled: number;
  failed: number;
  retried: number;
  skipped: number;
}

/** Ligne de la file de resynchronisation (vue admin). */
export interface ShipstationSyncListItem {
  orderId: string;
  orderNumber: string;
  orderStatus: Order['status'];
  totalCents: number;
  currency: Order['currency'];
  paidAt: Date | null;
  status: ShipstationSync['status'];
  operation: ShipstationSync['operation'];
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  shipstationOrderId: string | null;
  updatedAt: Date;
}

/**
 * Poussée des commandes vers ShipStation (tâche 13).
 *
 * BigCommerce jouait ce rôle ; nous le reprenons sans rien changer au
 * quotidien de l'équipe d'expédition, qui continue de créer ses étiquettes
 * dans ShipStation.
 *
 * Le service DRAINE la boîte d'envoi `shipstation_syncs` (écrite par la
 * finalisation de la commande, dans la transaction du passage à `PAID`) :
 *
 *   - **Idempotence** : avant toute création, la commande est cherchée par
 *     référence externe (`orderNumber`). Trouvée ⇒ on enregistre son id et
 *     on s'arrête. Et même si cette recherche échouait, `orderKey` rend le
 *     `createorder` de ShipStation un upsert : jamais de doublon.
 *   - **Robustesse** : erreurs réseau / 429 / 5xx ⇒ recul exponentiel ;
 *     après `SHIPSTATION_MAX_ATTEMPTS`, la ligne passe `SYNC_FAILED` avec
 *     sa cause et devient visible dans `/v1/admin/shipstation` (« repousser »).
 *     Une erreur 4xx (payload refusé, clés révoquées) n'est jamais retentée.
 *   - **Throttling** : porté par le client (40 requêtes/minute).
 */
@Injectable()
export class ShipstationSyncService {
  private readonly logger = new Logger(ShipstationSyncService.name);
  private readonly storeId: number | undefined;
  /** Un seul drain à la fois dans ce processus. */
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ShipstationClient,
    private readonly lifecycle: OrderLifecycleService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.storeId = config.get('SHIPSTATION_STORE_ID', { infer: true });
  }

  /* -------------------------------- Drain -------------------------------- */

  /**
   * Traite les lignes dues. Appelé par un job BullMQ répétable (production)
   * ou par une minuterie dans le processus API (dev sans Redis).
   */
  async drain(): Promise<DrainReport> {
    const report: DrainReport = {
      processed: 0,
      synced: 0,
      cancelled: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
    };
    if (this.draining) return report;
    if (!this.client.isConfigured()) {
      // Les lignes restent dues : rien n'est perdu, aucune tentative consommée.
      return report;
    }

    this.draining = true;
    try {
      const due = await this.prisma.shipstationSync.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: DRAIN_BATCH_SIZE,
      });

      for (const row of due) {
        if (!(await this.claim(row))) continue;
        report.processed += 1;
        const outcome = await this.processRow(row.orderId);
        report[outcome] += 1;
      }
    } finally {
      this.draining = false;
    }
    return report;
  }

  /**
   * Bail optimiste : repousse `next_attempt_at` avant l'appel réseau. Deux
   * instances ne traitent pas la même ligne, et un processus tué en plein
   * appel laisse la ligne retentable après le bail.
   */
  private async claim(row: ShipstationSync): Promise<boolean> {
    const claimed = await this.prisma.shipstationSync.updateMany({
      where: { id: row.id, status: 'PENDING', nextAttemptAt: row.nextAttemptAt },
      data: {
        nextAttemptAt: new Date(Date.now() + SHIPSTATION_LEASE_MS),
        lastAttemptAt: new Date(),
      },
    });
    return claimed.count > 0;
  }

  /** Traite UNE ligne (déjà réclamée) et gère son issue. */
  private async processRow(
    orderId: string,
  ): Promise<'synced' | 'cancelled' | 'failed' | 'retried' | 'skipped'> {
    const row = await this.prisma.shipstationSync.findUnique({ where: { orderId } });
    if (!row) return 'skipped';

    try {
      const outcome =
        row.operation === 'CREATE'
          ? await this.pushOrder(orderId)
          : await this.cancelOrder(orderId);
      return outcome;
    } catch (error) {
      return this.recordFailure(orderId, error);
    }
  }

  /**
   * Enregistre l'échec : retentative planifiée (recul exponentiel) tant que
   * l'erreur est retentable et que le quota de tentatives n'est pas épuisé ;
   * sinon `SYNC_FAILED` avec la cause, visible dans l'admin.
   */
  private async recordFailure(orderId: string, error: unknown): Promise<'retried' | 'failed'> {
    const retryable = error instanceof ShipstationError ? error.retryable : true;
    const cause = describeError(error);

    const row = await this.prisma.shipstationSync.update({
      where: { orderId },
      data: { attempts: { increment: 1 }, lastError: cause.slice(0, 1000) },
    });

    if (retryable && row.attempts < SHIPSTATION_MAX_ATTEMPTS) {
      await this.prisma.shipstationSync.update({
        where: { orderId },
        data: {
          status: 'PENDING',
          nextAttemptAt: new Date(Date.now() + backoffDelayMs(row.attempts)),
        },
      });
      this.logger.warn(
        `ShipStation ${row.operation} (commande ${orderId}) : tentative ${row.attempts}/${SHIPSTATION_MAX_ATTEMPTS} — ${cause}`,
      );
      return 'retried';
    }

    await this.prisma.shipstationSync.update({
      where: { orderId },
      data: { status: 'SYNC_FAILED', nextAttemptAt: null },
    });
    this.logger.error(
      `ShipStation ${row.operation} (commande ${orderId}) EN ÉCHEC DÉFINITIF après ${row.attempts} tentative(s) — ${cause}`,
    );
    await this.audit.log({
      action: 'shipstation.sync_failed',
      actorType: 'system',
      entityType: 'order',
      entityId: orderId,
      metadata: { operation: row.operation, attempts: row.attempts, cause: cause.slice(0, 500) },
    });
    return 'failed';
  }

  /* ------------------------- Création / mise à jour ---------------------- */

  private async pushOrder(orderId: string): Promise<'synced' | 'skipped' | 'cancelled'> {
    const order = await this.loadOrder(orderId);

    // Annulée avant d'avoir été poussée : il n'y a rien à créer.
    if (NOT_TO_PUSH.includes(order.status as (typeof NOT_TO_PUSH)[number])) {
      await this.prisma.shipstationSync.update({
        where: { orderId },
        data: { status: 'SKIPPED', operation: 'CANCEL', nextAttemptAt: null, lastError: null },
      });
      return 'skipped';
    }

    // 1. RÉFÉRENCE EXTERNE d'abord : un job rejoué ne crée pas de doublon.
    const existing = await this.client.findOrderByNumber(order.number);
    const shipstationOrderId = existing
      ? existing.orderId
      : (
          await this.client.createOrUpdateOrder(
            buildOrderPayload(order.mapped, { storeId: this.storeId }),
          )
        ).orderId;

    await this.prisma.shipstationSync.update({
      where: { orderId },
      data: {
        status: 'SYNCED',
        shipstationOrderId: String(shipstationOrderId),
        shipstationOrderKey: order.number,
        syncedAt: new Date(),
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    this.logger.log(
      `Commande ${order.number} ${existing ? 'déjà présente' : 'créée'} dans ShipStation (id ${shipstationOrderId}).`,
    );
    await this.audit.log({
      action: 'shipstation.order_pushed',
      actorType: 'system',
      entityType: 'order',
      entityId: orderId,
      metadata: { number: order.number, shipstationOrderId, alreadyExisted: Boolean(existing) },
    });

    // 2. Course : la commande a pu être annulée (ou remboursée) pendant
    //    l'appel réseau. Elle est maintenant connue de ShipStation — on arme
    //    l'annulation plutôt que de laisser partir un colis payé puis rendu.
    const fresh = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    if (NOT_TO_PUSH.includes(fresh.status as (typeof NOT_TO_PUSH)[number])) {
      await requestShipstationCancellation(this.prisma, orderId);
      return 'cancelled';
    }

    // 3. La commande est entre les mains de l'équipe d'expédition.
    if (fresh.status === 'PAID') {
      await this.lifecycle.markProcessing(orderId, { type: 'system' }, 'Transmise à ShipStation');
    }
    return 'synced';
  }

  /* ------------------------------ Annulation ----------------------------- */

  private async cancelOrder(orderId: string): Promise<'cancelled' | 'skipped'> {
    const row = await this.prisma.shipstationSync.findUniqueOrThrow({ where: { orderId } });
    if (!row.shipstationOrderId) {
      await this.prisma.shipstationSync.update({
        where: { orderId },
        data: { status: 'SKIPPED', nextAttemptAt: null },
      });
      return 'skipped';
    }

    // Garde-fou ultime : une étiquette a pu être créée entre la demande
    // d'annulation et ce passage. Le colis part — on ne touche à rien et on
    // fait remonter le cas dans la file d'échec (processus manuel).
    if (await hasShipstationLabel(this.prisma, orderId)) {
      await this.prisma.shipstationSync.update({
        where: { orderId },
        data: {
          status: 'SYNC_FAILED',
          nextAttemptAt: null,
          lastError: LABEL_ALREADY_CREATED_CAUSE,
        },
      });
      await this.audit.log({
        action: 'shipstation.cancel_blocked',
        actorType: 'system',
        entityType: 'order',
        entityId: orderId,
        metadata: { shipstationOrderId: row.shipstationOrderId },
      });
      return 'skipped';
    }

    const order = await this.loadOrder(orderId);
    await this.client.createOrUpdateOrder(
      buildOrderPayload(order.mapped, {
        storeId: this.storeId,
        status: 'cancelled',
        shipstationOrderId: Number(row.shipstationOrderId),
      }),
    );

    await this.prisma.shipstationSync.update({
      where: { orderId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    await this.audit.log({
      action: 'shipstation.order_cancelled',
      actorType: 'system',
      entityType: 'order',
      entityId: orderId,
      metadata: { number: order.number, shipstationOrderId: row.shipstationOrderId },
    });
    return 'cancelled';
  }

  /* --------------------------- Action « repousser » ---------------------- */

  /**
   * Réarme une ligne en échec puis la traite immédiatement (endpoint admin).
   * L'opération rejouée est celle qui avait échoué — création ou annulation.
   */
  async retry(orderId: string, actor: TransitionActor): Promise<ShipstationSyncListItem> {
    const row = await this.prisma.shipstationSync.findUnique({ where: { orderId } });
    if (!row)
      throw new NotFoundException('Aucune synchronisation ShipStation pour cette commande.');

    await this.prisma.shipstationSync.update({
      where: { orderId },
      data: { status: 'PENDING', attempts: 0, lastError: null, nextAttemptAt: new Date() },
    });
    await this.audit.log({
      action: 'shipstation.retry',
      actorType: actor.type,
      actorId: actor.userId ?? null,
      entityType: 'order',
      entityId: orderId,
      metadata: { operation: row.operation, previousStatus: row.status },
    });

    if (this.client.isConfigured()) {
      const claimed = await this.prisma.shipstationSync.findUniqueOrThrow({ where: { orderId } });
      if (await this.claim(claimed)) await this.processRow(orderId);
    }
    return this.detail(orderId);
  }

  /* -------------------------------- Lecture ------------------------------ */

  /** Les clés API sont-elles configurées ? (bandeau de la vue admin) */
  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  /** Une commande donnée est-elle poussée ? (page de détail admin, tests) */
  syncFor(orderId: string): Promise<ShipstationSync | null> {
    return this.prisma.shipstationSync.findUnique({ where: { orderId } });
  }

  /** Ligne enrichie d'une commande (réponse de l'action « repousser »). */
  async detail(orderId: string): Promise<ShipstationSyncListItem> {
    const row = await this.prisma.shipstationSync.findUniqueOrThrow({
      where: { orderId },
      include: {
        order: {
          select: { number: true, status: true, totalCents: true, currency: true, paidAt: true },
        },
      },
    });
    return toListItem(row);
  }

  /**
   * File de synchronisation pour l'admin. Par défaut : les commandes en
   * échec, les plus anciennes d'abord — ce sont elles qui bloquent des colis.
   */
  async list(params: {
    status?: ShipstationSync['status'];
    limit: number;
    cursor?: string;
  }): Promise<{ items: ShipstationSyncListItem[]; nextCursor: string | null }> {
    const rows = await this.prisma.shipstationSync.findMany({
      where: { status: params.status ?? 'SYNC_FAILED' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: {
        order: {
          select: { number: true, status: true, totalCents: true, currency: true, paidAt: true },
        },
      },
    });

    return {
      items: rows.slice(0, params.limit).map(toListItem),
      nextCursor: rows.length > params.limit ? (rows[params.limit - 1]?.id ?? null) : null,
    };
  }

  /** Compteurs par statut (bandeau de la vue de resynchronisation). */
  async counts(): Promise<Record<ShipstationSync['status'], number>> {
    const grouped = await this.prisma.shipstationSync.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = { PENDING: 0, SYNCED: 0, SYNC_FAILED: 0, CANCELLED: 0, SKIPPED: 0 };
    for (const group of grouped) counts[group.status] = group._count._all;
    return counts;
  }

  /* -------------------------------- Interne ------------------------------ */

  private async loadOrder(
    orderId: string,
  ): Promise<{ number: string; status: Order['status']; mapped: MappedOrder }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, user: { select: { email: true } } },
    });
    if (!order) throw new NotFoundException(`Commande ${orderId} introuvable.`);

    const variantIds = order.items
      .map((item) => item.variantId)
      .filter((id): id is string => id !== null);
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, weightGrams: true },
    });
    const weightByVariant = new Map(variants.map((v) => [v.id, v.weightGrams]));

    const shippingAddress = order.shippingAddress as unknown as OrderAddressSnapshot | null;
    if (!shippingAddress) {
      // Non retentable : une commande payée sans adresse est une anomalie de données.
      throw new ShipstationError(
        `Commande ${order.number} sans adresse de livraison — poussée impossible.`,
        null,
        false,
      );
    }

    return {
      number: order.number,
      status: order.status,
      mapped: {
        id: order.id,
        number: order.number,
        locale: order.locale as Locale,
        paidAt: order.paidAt,
        placedAt: order.placedAt,
        customerEmail: order.guestEmail ?? order.user?.email ?? null,
        shippingAddress,
        billingAddress: order.billingAddress as unknown as OrderAddressSnapshot | null,
        items: order.items.map((item: OrderItem) => ({
          id: item.id,
          sku: item.sku,
          nameFr: item.nameFr,
          nameEn: item.nameEn,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          taxCents: item.taxCents,
          weightGrams: item.variantId ? (weightByVariant.get(item.variantId) ?? null) : null,
        })),
        discountCents: order.discountCents,
        shippingCents: order.shippingCents,
        totalTaxCents:
          order.taxGstCents + order.taxQstCents + order.taxHstCents + order.taxPstCents,
        totalCents: order.totalCents,
        customerNote: order.customerNote,
      },
    };
  }
}

/** Ligne `shipstation_syncs` + sa commande → élément de liste admin. */
function toListItem(
  row: ShipstationSync & {
    order: Pick<Order, 'number' | 'status' | 'totalCents' | 'currency' | 'paidAt'>;
  },
): ShipstationSyncListItem {
  return {
    orderId: row.orderId,
    orderNumber: row.order.number,
    orderStatus: row.order.status,
    totalCents: row.order.totalCents,
    currency: row.order.currency,
    paidAt: row.order.paidAt,
    status: row.status,
    operation: row.operation,
    attempts: row.attempts,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
    nextAttemptAt: row.nextAttemptAt,
    shipstationOrderId: row.shipstationOrderId,
    updatedAt: row.updatedAt,
  };
}

function describeError(error: unknown): string {
  if (error instanceof ShipstationError) {
    return error.body ? `${error.message} — ${error.body}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
