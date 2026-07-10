import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { carrierLabel, type Locale, type ShipmentStatus } from '@ffc/core';
import { PrismaService } from '../../../database';
import { MailQueueService } from '../../mail/mail-queue.service';
import { type MailTemplateKey } from '../../mail/templates';
import { OrderLifecycleService } from '../../orders/lifecycle/order-lifecycle.service';
import { PushService } from '../../push/push.service';
import { type PushTemplateKey } from '../../push/push-templates';
import { type ShipmentWithOrder } from './tracking-ingest.service';

/**
 * JALONS de suivi (tâche 14) : réactions aux transitions de statut d'un
 * colis, dispatchées par l'ingestion (événement interne).
 *
 *   - **en livraison** (`OUT_FOR_DELIVERY`) → courriel + push ;
 *   - **exception** (`EXCEPTION`) → courriel + push ;
 *   - **livré** (`DELIVERED`) → quand TOUS les colis de la commande sont
 *     livrés : la commande passe `DELIVERED` (machine d'états de la
 *     tâche 12 — c'est ELLE qui envoie le courriel de livraison) + push.
 *
 * (« Expédié » est déjà notifié par les tâches 12/13 au passage à SHIPPED.)
 *
 * ANTI-DOUBLON STRICT : chaque jalon porte une clé d'idempotence stable
 * (par colis pour en livraison/exception, par commande pour livré) sur les
 * DEUX canaux — le polling peut revoir l'événement autant de fois qu'il
 * veut, une seule notification part. Un jalon dont la trace existe déjà
 * (envoyée, sautée ou échouée) n'est jamais rejoué : les retentatives
 * d'envoi appartiennent à la file de courriels, pas au polling.
 *
 * PRÉFÉRENCES : le courriel des jalons intermédiaires respecte une
 * désactivation EXPLICITE (TRANSACTIONAL × EMAIL) ; le courriel de livraison
 * reste le transactionnel de la tâche 12 (toujours envoyé). Le push
 * respecte TRANSACTIONAL × PUSH (vérifié dans PushService).
 */
@Injectable()
export class TrackingMilestonesService {
  private readonly logger = new Logger(TrackingMilestonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailQueue: MailQueueService,
    private readonly push: PushService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  async onTransition(
    shipment: ShipmentWithOrder,
    from: ShipmentStatus,
    to: ShipmentStatus,
  ): Promise<void> {
    switch (to) {
      case 'OUT_FOR_DELIVERY':
        await this.notifyShipmentMilestone(shipment, 'shipment_out_for_delivery');
        return;
      case 'EXCEPTION':
        await this.notifyShipmentMilestone(shipment, 'shipment_exception');
        return;
      case 'DELIVERED':
        await this.onDelivered(shipment);
        return;
      default:
        // PICKED_UP / IN_TRANSIT / RETURNED : chronologie seulement, pas de
        // notification (le retour déclenche un processus interne, tâche 22).
        this.logger.log(
          `Colis ${shipment.trackingNumber ?? shipment.id} : ${from} → ${to} (sans notification).`,
        );
    }
  }

  /* --------------------- En livraison / exception ---------------------- */

  private async notifyShipmentMilestone(
    shipment: ShipmentWithOrder,
    templateKey: MailTemplateKey &
      PushTemplateKey &
      ('shipment_out_for_delivery' | 'shipment_exception'),
  ): Promise<void> {
    const order = shipment.order;
    const locale = order.locale as Locale;
    const carrier = shipment.carrier ? carrierLabel(shipment.carrier, locale) : '';
    const variables = {
      orderNumber: order.number,
      carrier,
      trackingNumber: shipment.trackingNumber ?? '',
      trackingUrl: shipment.trackingUrl ?? '',
    };

    const email = order.guestEmail ?? order.user?.email ?? null;
    const emailKey = `${templateKey}:${shipment.id}`;
    if (email && (await this.emailMilestoneAllowed(order.userId, emailKey))) {
      await this.mailQueue.enqueue({
        userId: order.userId,
        to: email,
        locale,
        templateKey,
        variables,
        category: 'TRANSACTIONAL',
        orderId: order.id,
        idempotencyKey: emailKey,
      });
    }

    await this.push.send({
      userId: order.userId,
      locale,
      templateKey,
      variables,
      data: { orderId: order.id, shipmentId: shipment.id },
      idempotencyKey: `${templateKey}:push:${shipment.id}`,
      orderId: order.id,
    });
  }

  /**
   * Jalon déjà traité (clé existante) → jamais rejoué. Préférence courriel
   * transactionnelle EXPLICITEMENT désactivée → trace SKIPPED qui consomme
   * le jalon.
   */
  private async emailMilestoneAllowed(userId: string | null, key: string): Promise<boolean> {
    const existing = await this.prisma.notification.findUnique({
      where: { idempotencyKey: key },
      select: { id: true },
    });
    if (existing) return false;

    if (!userId) return true; // invité : pas de préférences, courriel direct
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId_category_channel: { userId, category: 'TRANSACTIONAL', channel: 'EMAIL' } },
      select: { enabled: true },
    });
    if (preference?.enabled === false) {
      await this.prisma.notification.create({
        data: {
          userId,
          category: 'TRANSACTIONAL',
          channel: 'EMAIL',
          status: 'SKIPPED',
          templateKey: key.split(':')[0]!,
          failureReason: 'Préférence désactivée',
          idempotencyKey: key,
        },
      });
      return false;
    }
    return true;
  }

  /* ------------------------------- Livré -------------------------------- */

  private async onDelivered(shipment: ShipmentWithOrder): Promise<void> {
    const order = shipment.order;

    // Envoi multi-colis : la commande n'est « livrée » que lorsque le
    // DERNIER colis l'est. Les colis retournés ou en incident bloquent la
    // livraison automatique (traitement humain, tâche 22).
    const undelivered = await this.prisma.shipment.count({
      where: { orderId: order.id, status: { not: 'DELIVERED' } },
    });
    if (undelivered > 0) {
      this.logger.log(
        `Commande ${order.number} : colis livré, ${undelivered} autre(s) encore en route.`,
      );
      return;
    }

    // Machine d'états de la tâche 12 : passe la commande à DELIVERED et
    // envoie le courriel de livraison (idempotent par commande).
    try {
      await this.lifecycle.markDelivered(order.id, { type: 'system' });
    } catch (error) {
      if (error instanceof ConflictException) {
        // Commande remboursée/annulée entre-temps : la chronologie du colis
        // reste juste, le statut de commande relève d'un humain.
        this.logger.warn(
          `Commande ${order.number} : livraison détectée mais transition refusée (${order.status}).`,
        );
      } else {
        throw error;
      }
    }

    await this.push.send({
      userId: order.userId,
      locale: order.locale as Locale,
      templateKey: 'order_delivered',
      variables: { orderNumber: order.number },
      data: { orderId: order.id, shipmentId: shipment.id },
      idempotencyKey: `order_delivered:push:${order.id}`,
      orderId: order.id,
    });
  }
}
