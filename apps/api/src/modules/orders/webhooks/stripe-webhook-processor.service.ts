import { Injectable, Logger } from '@nestjs/common';
import { type OrderStatus, type RefundStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { OrderFinalizerService } from '../finalize/order-finalizer.service';
import { OrderMailService } from '../invoices/order-mail.service';
import { StripeService } from '../stripe/stripe.service';

/** Événements traités — tout autre type est consigné IGNORED. */
export const HANDLED_STRIPE_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
] as const;

function refundStatusFrom(stripeStatus: string | null): RefundStatus {
  switch (stripeStatus) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

/**
 * Consommateur des événements Stripe (tâche 11) — appelé par la file
 * BullMQ (worker.ts) ou inline sans Redis.
 *
 * Idempotence à TROIS niveaux, un rejeu ne produit aucun double effet :
 *   1. unicité (source, external_id) de webhook_events — un rejeu HTTP ne
 *      crée même pas de second enregistrement ;
 *   2. statut de la ligne : PROCESSED/IGNORED ⇒ retraitement refusé ;
 *   3. chaque gestionnaire est idempotent par lui-même (transition
 *      conditionnelle PENDING→PAID, upsert des remboursements…) — ceinture
 *      et bretelles si un job est rejoué après un crash à mi-chemin.
 */
@Injectable()
export class StripeWebhookProcessorService {
  private readonly logger = new Logger(StripeWebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly finalizer: OrderFinalizerService,
    private readonly orderMail: OrderMailService,
    private readonly audit: AuditService,
  ) {}

  async process(webhookEventId: string): Promise<void> {
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!row) return;
    if (row.status === 'PROCESSED' || row.status === 'IGNORED') return;

    await this.prisma.webhookEvent.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });

    const event = row.payload as unknown as Stripe.Event;
    try {
      const handled = await this.dispatch(event);
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: {
          status: handled ? 'PROCESSED' : 'IGNORED',
          processedAt: new Date(),
          failureReason: null,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: 'FAILED', failureReason: reason.slice(0, 1000) },
      });
      this.logger.error(`Webhook ${event.type} (${row.externalId}) en échec : ${reason}`);
      throw error; // BullMQ retente avec backoff exponentiel
    }
  }

  /** true = événement pris en charge ; false = à consigner IGNORED. */
  private async dispatch(event: Stripe.Event): Promise<boolean> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        return this.onPaymentSucceeded(event.data.object);
      case 'payment_intent.payment_failed':
        return this.onPaymentFailed(event.data.object);
      case 'charge.refunded':
        return this.onChargeRefunded(event.data.object);
      case 'charge.dispute.created':
        return this.onDisputeCreated(event.data.object);
      default:
        return false;
    }
  }

  /* ------------------------- payment_intent.succeeded -------------------- */

  private async onPaymentSucceeded(intent: Stripe.PaymentIntent): Promise<boolean> {
    const orderId = intent.metadata?.orderId;
    if (!orderId) return false; // intent étranger à la boutique

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) return false;
    // Déjà finalisée (retour client ou rejeu) : rien à faire, AUCUN appel réseau.
    if (order.status !== 'PENDING') return true;

    // Recharge l'intent DÉPLIÉ (détails de charge pour le reçu) — et
    // au passage, l'état vient de Stripe, pas seulement du payload reçu.
    const expanded = await this.stripe.retrievePaymentIntent(intent.id);
    if (expanded.status !== 'succeeded') {
      this.logger.warn(
        `payment_intent.succeeded reçu mais l'intent ${intent.id} est « ${expanded.status} » — ignoré.`,
      );
      return true;
    }
    await this.finalizer.finalizePaidOrder(orderId, expanded);
    return true;
  }

  /* ----------------------- payment_intent.payment_failed ----------------- */

  private async onPaymentFailed(intent: Stripe.PaymentIntent): Promise<boolean> {
    const failure = intent.last_payment_error;
    await this.prisma.payment.updateMany({
      where: {
        provider: 'STRIPE',
        externalId: intent.id,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'FAILED',
        failureCode: failure?.code ?? failure?.decline_code ?? null,
        failureMessage: failure?.message?.slice(0, 500) ?? null,
      },
    });

    // Courriel « paiement échoué » (idempotent par intent : un rejeu du même
    // événement n'envoie qu'un courriel). La commande reste PENDING — le
    // client peut représenter un moyen de paiement sur le même intent.
    const orderId = intent.metadata?.orderId;
    if (orderId) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (order?.status === 'PENDING') {
        await this.orderMail.sendPaymentFailed(orderId, failure?.message ?? null, intent.id);
      }
      return true;
    }
    return false;
  }

  /* ------------------------------ charge.refunded ------------------------ */

  private async onChargeRefunded(charge: Stripe.Charge): Promise<boolean> {
    const intentId =
      typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!intentId) return false;

    const payment = await this.prisma.payment.findUnique({
      where: { provider_externalId: { provider: 'STRIPE', externalId: intentId } },
    });
    if (!payment) return false; // charge inconnue de la boutique

    const fullyRefunded = charge.amount_refunded >= charge.amount;

    // Les payloads récents n'embarquent plus la liste des remboursements :
    // repli sur l'API. Un rejeu converge grâce à l'upsert par external_id.
    const refunds = charge.refunds?.data ?? (await this.stripe.listRefundsForCharge(charge.id));

    await this.prisma.$transaction(async (tx) => {
      // Upsert de chaque remboursement : les rejeux et notre propre
      // remboursement (stock insuffisant) convergent sans doublon.
      for (const refund of refunds) {
        await tx.refund.upsert({
          where: { provider_externalId: { provider: 'STRIPE', externalId: refund.id } },
          update: { status: refundStatusFrom(refund.status) },
          create: {
            orderId: payment.orderId,
            paymentId: payment.id,
            provider: 'STRIPE',
            status: refundStatusFrom(refund.status),
            amountCents: refund.amount,
            currency: 'CAD',
            reason: refund.metadata?.reason ?? refund.reason ?? null,
            externalId: refund.id,
          },
        });
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });

      // Une commande ANNULÉE (stock insuffisant) reste annulée : le
      // remboursement en est la conséquence, pas un nouveau statut.
      const target: OrderStatus = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const order = await tx.order.findUniqueOrThrow({
        where: { id: payment.orderId },
        select: { status: true },
      });
      if (order.status !== target && order.status !== 'CANCELLED' && order.status !== 'PENDING') {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: target } });
        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            fromStatus: order.status,
            toStatus: target,
            note: `Remboursement Stripe (${(charge.amount_refunded / 100).toFixed(2)} $)`,
          },
        });
      }
    });
    // NOTE : aucun retour automatique en stock — la remise en inventaire
    // est une décision d'opération (retour physique), tâches 12/22.
    return true;
  }

  /* --------------------------- charge.dispute.created -------------------- */

  private async onDisputeCreated(dispute: Stripe.Dispute): Promise<boolean> {
    const intentId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    if (!intentId) return false;

    const payment = await this.prisma.payment.findUnique({
      where: { provider_externalId: { provider: 'STRIPE', externalId: intentId } },
      include: { order: { select: { id: true, number: true, internalNote: true } } },
    });
    if (!payment) return false;

    const note = `[Litige Stripe ${dispute.id}] motif : ${dispute.reason} — montant ${(
      dispute.amount / 100
    ).toFixed(2)} $. Répondre avant l'échéance dans le Dashboard Stripe.`;
    const internalNote = payment.order.internalNote
      ? `${payment.order.internalNote}\n${note}`
      : note;
    // Idempotence du rejeu : la note n'est ajoutée qu'une fois par litige.
    if (!payment.order.internalNote?.includes(dispute.id)) {
      await this.prisma.order.update({
        where: { id: payment.order.id },
        data: { internalNote },
      });
    }

    await this.audit.log({
      action: 'order.dispute_created',
      actorType: 'webhook',
      entityType: 'order',
      entityId: payment.order.id,
      metadata: {
        number: payment.order.number,
        disputeId: dispute.id,
        reason: dispute.reason,
        amountCents: dispute.amount,
      },
    });
    return true;
  }
}
