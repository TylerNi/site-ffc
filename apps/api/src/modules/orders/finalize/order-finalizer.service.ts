import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { MailService } from '../../mail/mail.service';
import { StripeService } from '../stripe/stripe.service';

export type FinalizeOutcome = 'FINALIZED' | 'ALREADY_DONE' | 'CANCELLED_INSUFFICIENT_STOCK';

/** Échec de stock pendant la finalisation — déclenche annulation + remboursement. */
class InsufficientStockError extends Error {
  constructor(readonly sku: string) {
    super(`Stock insuffisant pour ${sku}`);
  }
}

/** Détails de charge utiles au reçu, extraits d'un intent DÉPLIÉ. */
function chargeDetails(intent: Stripe.PaymentIntent): {
  stripeChargeId: string | null;
  paymentMethodType: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl: string | null;
} {
  const charge =
    intent.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card ?? null;
  return {
    stripeChargeId: charge?.id ?? null,
    paymentMethodType: charge?.payment_method_details?.type ?? null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    receiptUrl: charge?.receipt_url ?? null,
  };
}

/**
 * Finalisation ATOMIQUE d'une commande payée (tâche 11).
 *
 * Appelée par le webhook `payment_intent.succeeded` ET par le retour
 * client (page de succès) — le premier arrivé gagne, l'autre ne fait RIEN :
 * la transition PENDING → PAID est un UPDATE conditionnel qui sert de
 * verrou. Dans LA MÊME transaction :
 *   - stock décrémenté par UPDATE conditionnel (quantité vendable
 *     suffisante) — l'échec ANNULE tout et déclenche un remboursement
 *     intégral (deux checkouts sur le dernier article : un seul passe) ;
 *   - mouvements d'inventaire SALE consignés ;
 *   - coupon consommé (compteur + coupon_redemptions) ;
 *   - paiement marqué SUCCEEDED avec les détails de reçu (marque, last4 —
 *     JAMAIS de numéro de carte : périmètre PCI SAQ A) ;
 *   - panier CONVERTED, historique de statut consigné.
 * Le courriel de confirmation part APRÈS le commit, une seule fois.
 */
@Injectable()
export class OrderFinalizerService {
  private readonly logger = new Logger(OrderFinalizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async finalizePaidOrder(orderId: string, intent: Stripe.PaymentIntent): Promise<FinalizeOutcome> {
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        // Verrou logique : un seul finaliseur gagne la transition.
        const claimed = await tx.order.updateMany({
          where: { id: orderId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: new Date() },
        });
        if (claimed.count === 0) return 'ALREADY_DONE' as const;

        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { items: true },
        });

        for (const item of order.items) {
          if (!item.variantId) throw new InsufficientStockError(item.sku);
          // Décrément conditionnel : la ligne ne passe que si le stock
          // VENDABLE (en main − réservé) suffit. Les transactions
          // concurrentes se sérialisent sur le verrou de ligne PostgreSQL.
          const updated = await tx.$executeRaw`
            UPDATE inventory_levels
               SET quantity_on_hand = quantity_on_hand - ${item.quantity}
             WHERE variant_id = ${item.variantId}::uuid
               AND quantity_on_hand - quantity_reserved >= ${item.quantity}`;
          if (updated === 0) throw new InsufficientStockError(item.sku);

          await tx.inventoryMovement.create({
            data: {
              variantId: item.variantId,
              type: 'SALE',
              quantity: -item.quantity,
              orderId: order.id,
              reason: `Commande ${order.number}`,
            },
          });
        }

        if (order.couponId) {
          // La validité a été contrôlée à la cotation ; ici on CONSOMME.
          // Un client qui a payé garde sa remise même si le plafond global
          // a été atteint entre-temps (course rarissime, assumée).
          await tx.coupon.update({
            where: { id: order.couponId },
            data: { timesRedeemed: { increment: 1 } },
          });
          await tx.couponRedemption.create({
            data: {
              couponId: order.couponId,
              orderId: order.id,
              userId: order.userId,
              amountDiscountedCents: order.discountCents,
            },
          });
        }

        await tx.payment.updateMany({
          where: { orderId: order.id, provider: 'STRIPE', externalId: intent.id },
          data: {
            status: 'SUCCEEDED',
            capturedAt: new Date(),
            ...chargeDetails(intent),
          },
        });

        if (order.cartId) {
          await tx.cart.updateMany({
            where: { id: order.cartId },
            data: { status: 'CONVERTED' },
          });
        }

        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: 'PENDING',
            toStatus: 'PAID',
            note: 'Paiement Stripe confirmé',
          },
        });

        return 'FINALIZED' as const;
      });

      if (outcome === 'FINALIZED') await this.afterFinalized(orderId, intent);
      return outcome;
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        await this.cancelAndRefund(orderId, intent, error.sku);
        return 'CANCELLED_INSUFFICIENT_STOCK';
      }
      throw error;
    }
  }

  /* ----------------------- Succès : après le commit ---------------------- */

  private async afterFinalized(orderId: string, intent: Stripe.PaymentIntent): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, user: { select: { email: true } } },
    });
    const email = order.guestEmail ?? order.user?.email;

    await this.audit.log({
      action: 'order.paid',
      actorType: 'system',
      entityType: 'order',
      entityId: order.id,
      metadata: { number: order.number, totalCents: order.totalCents, paymentIntent: intent.id },
    });

    if (!email) return;
    const linesText = order.items
      .map(
        (item) =>
          `  ${item.quantity} × ${order.locale === 'fr' ? item.nameFr : item.nameEn} — ${(
            item.totalCents / 100
          ).toFixed(2)} $`,
      )
      .join('\n');
    try {
      await this.mail.send({
        userId: order.userId,
        to: email,
        locale: order.locale,
        templateKey: 'order_confirmation',
        variables: {
          orderNumber: order.number,
          total: `${(order.totalCents / 100).toFixed(2)} $ CA`,
          lines: linesText,
        },
      });
    } catch (error) {
      // Best effort : la commande est payée, le courriel ne bloque jamais.
      this.logger.error(`Courriel de confirmation impossible (commande ${order.number})`, error);
    }
  }

  /* ------------------- Échec de stock : annuler-rembourser --------------- */

  private async cancelAndRefund(
    orderId: string,
    intent: Stripe.PaymentIntent,
    sku: string,
  ): Promise<void> {
    const note = `Stock insuffisant après paiement (${sku}) — remboursement intégral automatique`;

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), internalNote: note },
      });
      if (claimed.count === 0) return false;
      await tx.orderStatusHistory.create({
        data: { orderId, fromStatus: 'PENDING', toStatus: 'CANCELLED', note },
      });
      // L'argent a bel et bien été capté : le paiement reste SUCCEEDED,
      // c'est la ligne de remboursement qui trace le retour des fonds.
      await tx.payment.updateMany({
        where: { orderId, provider: 'STRIPE', externalId: intent.id },
        data: { status: 'SUCCEEDED', capturedAt: new Date(), ...chargeDetails(intent) },
      });
      return true;
    });
    if (!cancelled) return; // course : un autre finaliseur a déjà statué

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, provider: 'STRIPE', externalId: intent.id },
    });

    try {
      const refund = await this.stripe.createRefund(intent.id, 'insufficient_stock');
      await this.prisma.refund.upsert({
        where: { provider_externalId: { provider: 'STRIPE', externalId: refund.id } },
        update: { status: refund.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING' },
        create: {
          orderId,
          paymentId: payment?.id ?? null,
          provider: 'STRIPE',
          status: refund.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
          amountCents: refund.amount,
          currency: 'CAD',
          reason: note,
          externalId: refund.id,
        },
      });
    } catch (error) {
      // Remboursement à rejouer manuellement — trace d'audit + journal.
      this.logger.error(
        `REMBOURSEMENT À FAIRE MANUELLEMENT : commande ${order.number}, intent ${intent.id}`,
        error,
      );
    }

    await this.audit.log({
      action: 'order.cancelled_insufficient_stock',
      actorType: 'system',
      entityType: 'order',
      entityId: orderId,
      metadata: { number: order.number, sku, paymentIntent: intent.id },
    });
  }
}

/** Ré-export pratique pour les tests (assertion d'erreur). */
export { InsufficientStockError };
