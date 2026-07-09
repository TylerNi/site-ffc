import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Order, type OrderStatus } from '@prisma/client';
import { canTransitionOrder, isClientCancellable } from '@ffc/core';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { OrderMailService } from '../invoices/order-mail.service';
import { RefundService } from '../refunds/refund.service';

/** Acteur d'une transition — trace dans order_status_history + audit. */
export interface TransitionActor {
  type: 'client' | 'admin' | 'system';
  userId?: string | null;
}

/** Effet secondaire (courriel) branché sur une transition SHIPPED/DELIVERED. */
export interface ShipmentNotice {
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}

const SYSTEM: TransitionActor = { type: 'system' };

/**
 * Machine d'états des commandes (tâche 12).
 *
 * Chemin nominal `PAID → PROCESSING → SHIPPED → DELIVERED`, plus les branches
 * d'annulation et de remboursement. Chaque transition :
 *   - est VALIDÉE (table @ffc/core — un saut illégal est refusé) ;
 *   - est ATOMIQUE (UPDATE conditionnel sur le statut de départ : un double
 *     appel ou une course ne franchit la transition qu'une fois) ;
 *   - est HISTORISÉE dans order_status_history avec l'acteur (client, admin,
 *     système) et l'horodatage ;
 *   - déclenche ses effets (courriel d'expédition/livraison ; l'annulation
 *     restocke et rembourse).
 *
 * Les transitions d'argent (CANCELLED avec remboursement, REFUNDED /
 * PARTIALLY_REFUNDED) passent par `cancel()` / RefundService, pas par le
 * `transition()` générique.
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundService,
    private readonly orderMail: OrderMailService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------- Transitions de traitement -------------------- */

  markProcessing(orderId: string, actor: TransitionActor = SYSTEM, note?: string): Promise<Order> {
    return this.transition(orderId, 'PROCESSING', actor, note);
  }

  async markShipped(
    orderId: string,
    actor: TransitionActor = SYSTEM,
    shipment?: ShipmentNotice,
  ): Promise<Order> {
    const order = await this.transition(orderId, 'SHIPPED', actor, 'Remise au transporteur', {
      shippedAt: new Date(),
    });
    await this.orderMail.sendShipped(orderId, shipment ?? {});
    return order;
  }

  async markDelivered(orderId: string, actor: TransitionActor = SYSTEM): Promise<Order> {
    const order = await this.transition(orderId, 'DELIVERED', actor, 'Colis livré', {
      deliveredAt: new Date(),
    });
    await this.orderMail.sendDelivered(orderId);
    return order;
  }

  /**
   * Transition générique VALIDÉE et ATOMIQUE (traitement uniquement).
   * Les cibles CANCELLED / REFUNDED / PARTIALLY_REFUNDED sont refusées ici :
   * elles impliquent de l'argent (voir `cancel()` et RefundService).
   */
  async transition(
    orderId: string,
    to: OrderStatus,
    actor: TransitionActor = SYSTEM,
    note?: string,
    extraData?: Partial<Pick<Order, 'shippedAt' | 'deliveredAt'>>,
  ): Promise<Order> {
    if (to === 'CANCELLED' || to === 'REFUNDED' || to === 'PARTIALLY_REFUNDED') {
      throw new ConflictException(
        `La transition vers ${to} passe par cancel()/RefundService, pas par transition().`,
      );
    }

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.status === to) return order; // idempotent : déjà dans l'état visé
    if (!canTransitionOrder(order.status, to)) {
      throw new ConflictException({
        code: 'ILLEGAL_TRANSITION',
        message: `Transition illégale : ${order.status} → ${to}.`,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Verrou logique : la transition ne franchit qu'à partir du statut lu.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: to, ...extraData },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'STATUS_CHANGED',
          message: 'Le statut de la commande a changé — réessayez.',
        });
      }
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: to,
          changedByUserId: actor.userId ?? null,
          note: note ?? null,
        },
      });
      return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    });

    await this.audit.log({
      action: `order.status.${to.toLowerCase()}`,
      actorType: actor.type,
      actorId: actor.userId ?? null,
      entityType: 'order',
      entityId: orderId,
      metadata: { number: updated.number, from: order.status, to },
    });
    return updated;
  }

  /* ------------------------------ Annulation --------------------------- */

  /**
   * Annulation par le CLIENT — permise tant que la commande n'est pas
   * poussée à l'expédition. Restock + remboursement Stripe intégral + note
   * de crédit + courriel d'annulation. Le client ne peut annuler que SES
   * commandes (vérifié par l'appelant : contrôleur « Mes commandes »).
   */
  cancelByClient(orderId: string, userId: string): Promise<CancelOutcome> {
    return this.cancel(orderId, { type: 'client', userId }, 'Annulation par le client', {
      clientRestricted: true,
    });
  }

  /**
   * Annule une commande (avant expédition), rembourse et restocke. Idempotent
   * par le verrou de transition : un second appel trouve la commande déjà
   * CANCELLED et sort proprement.
   */
  async cancel(
    orderId: string,
    actor: TransitionActor,
    reason: string,
    opts: { clientRestricted?: boolean } = {},
  ): Promise<CancelOutcome> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Commande introuvable.');

    if (order.status === 'CANCELLED') {
      return { orderId, status: 'CANCELLED', refundAmountCents: null, alreadyCancelled: true };
    }
    if (opts.clientRestricted && !isClientCancellable(order.status)) {
      throw new ConflictException({
        code: 'NOT_CANCELLABLE',
        message:
          'Cette commande ne peut plus être annulée (déjà expédiée, remboursée ou annulée). Contactez le soutien pour un retour.',
      });
    }
    if (!canTransitionOrder(order.status, 'CANCELLED')) {
      throw new ConflictException({
        code: 'NOT_CANCELLABLE',
        message: `Une commande « ${order.status} » ne peut pas être annulée.`,
      });
    }

    const wasPaid = order.status !== 'PENDING';

    // 1) Transition atomique → CANCELLED (verrou anti double-annulation).
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'STATUS_CHANGED',
          message: 'Le statut de la commande vient de changer — réessayez.',
        });
      }
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: 'CANCELLED',
          changedByUserId: actor.userId ?? null,
          note: reason,
        },
      });
    });

    // 2) Remboursement intégral + restock + note de crédit (l'ordre est
    //    déjà CANCELLED : RefundService conserve ce statut). Sans paiement
    //    capté (commande PENDING annulée par l'admin), rien à rembourser.
    let refundAmountCents: number | null = null;
    if (wasPaid) {
      const result = await this.refunds.refund(orderId, {
        restock: true,
        reason,
        actor,
        notify: false, // le courriel d'annulation ci-dessous suffit
        idempotencyKey: `refund:cancel:${orderId}`,
      });
      refundAmountCents = result.amountCents;
    }

    // 3) Courriel d'annulation (idempotent) — mentionne le remboursement.
    if (wasPaid) await this.orderMail.sendCancelled(orderId, refundAmountCents);

    await this.audit.log({
      action: 'order.cancelled',
      actorType: actor.type,
      actorId: actor.userId ?? null,
      entityType: 'order',
      entityId: orderId,
      metadata: { number: order.number, from: order.status, reason, refundAmountCents },
    });

    return { orderId, status: 'CANCELLED', refundAmountCents, alreadyCancelled: false };
  }
}

export interface CancelOutcome {
  orderId: string;
  status: 'CANCELLED';
  refundAmountCents: number | null;
  alreadyCancelled: boolean;
}
