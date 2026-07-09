import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type OrderItem, type OrderStatus } from '@prisma/client';
import { allocateProportionally, canTransitionOrder } from '@ffc/core';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { type CreditNoteSnapshot, InvoiceService } from '../invoices/invoice.service';
import { type InvoiceLineInput } from '../invoices/invoice-document';
import { OrderMailService } from '../invoices/order-mail.service';
import { StripeService } from '../stripe/stripe.service';

export interface RefundActor {
  type: 'client' | 'admin' | 'system';
  userId?: string | null;
}

export interface RefundRequest {
  /** Remboursement partiel PAR MONTANT (cents). Exclusif de `lineItemIds`. */
  amountCents?: number;
  /** Remboursement partiel PAR LIGNES (ids d'order_items). Exclusif de `amountCents`. */
  lineItemIds?: string[];
  /** Remet les unités remboursées en inventaire (retour physique). */
  restock: boolean;
  reason: string;
  actor: RefundActor;
  /** false = ne pas envoyer le courriel « remboursement » (l'annulation a le sien). */
  notify?: boolean;
  /** Clé d'idempotence Stripe (rejeu sûr). Générée si absente. */
  idempotencyKey?: string;
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
  fullyRefunded: boolean;
  creditNoteId: string | null;
  orderStatus: OrderStatus;
  alreadyDone: boolean;
}

/** Statuts de commande pour lesquels un remboursement a du sens. */
const REFUNDABLE_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'PARTIALLY_REFUNDED',
  'CANCELLED',
];

/**
 * Service INTERNE de remboursement (tâche 12) — total ou partiel (par lignes
 * ou par montant). L'écran admin arrive à la tâche 22 ; ce service est le
 * moteur, prêt et testé.
 *
 * Il orchestre, de bout en bout et de façon idempotente :
 *   Stripe (remboursement, clé d'idempotence) → ligne `refunds` (unicité sur
 *   l'id externe) → statut du paiement → restock optionnel (mouvements
 *   RETURN) → statut de la commande (machine d'états + historique daté avec
 *   acteur) → note de crédit (série CRN, PDF) → courriel.
 *
 * Rejouer un remboursement déjà effectué ne produit aucun second effet : la
 * ligne `refunds` existe déjà (id Stripe stable via la clé d'idempotence),
 * et l'opération sort tôt.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly invoices: InvoiceService,
    private readonly orderMail: OrderMailService,
    private readonly audit: AuditService,
  ) {}

  async refund(orderId: string, request: RefundRequest): Promise<RefundResult> {
    if (request.amountCents !== undefined && request.lineItemIds) {
      throw new BadRequestException(
        'Choisir un remboursement par montant OU par lignes, pas les deux.',
      );
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new ConflictException({
        code: 'ORDER_NOT_REFUNDABLE',
        message: `Une commande « ${order.status} » ne peut pas être remboursée.`,
      });
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        provider: 'STRIPE',
        status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        externalId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment?.externalId) {
      throw new ConflictException({
        code: 'NO_CAPTURED_PAYMENT',
        message: 'Aucun paiement Stripe capté à rembourser.',
      });
    }

    // Déjà remboursé (toutes lignes SUCCEEDED/PENDING).
    const priorRefunds = await this.prisma.refund.findMany({
      where: { orderId, status: { in: ['SUCCEEDED', 'PENDING'] } },
      select: { amountCents: true },
    });
    const alreadyRefunded = priorRefunds.reduce((sum, r) => sum + r.amountCents, 0);
    const remaining = payment.amountCents - alreadyRefunded;
    if (remaining <= 0) {
      throw new ConflictException({
        code: 'ALREADY_FULLY_REFUNDED',
        message: 'Cette commande est déjà entièrement remboursée.',
      });
    }

    // Lignes concernées + montant à rembourser.
    const restockLines = this.resolveLines(order.items, request);
    const amountCents = this.resolveAmount(request, restockLines, remaining);
    if (amountCents <= 0 || amountCents > remaining) {
      throw new BadRequestException({
        code: 'INVALID_REFUND_AMOUNT',
        message: `Montant de remboursement invalide (${amountCents} ; restant ${remaining}).`,
      });
    }

    // 1) Stripe (hors transaction). Clé d'idempotence ⇒ rejeu sûr.
    const idempotencyKey =
      request.idempotencyKey ?? `refund:${orderId}:${amountCents}:${alreadyRefunded}`;
    const stripeRefund = await this.stripe.createRefund({
      paymentIntentId: payment.externalId,
      amountCents: amountCents === remaining && alreadyRefunded === 0 ? undefined : amountCents,
      reason: request.reason,
      idempotencyKey,
    });

    // 2) Persistance atomique. `create` (pas upsert) : sait si c'est un rejeu.
    const fullyRefunded = alreadyRefunded + stripeRefund.amount >= payment.amountCents;
    let alreadyDone = false;

    const persisted = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.refund.findUnique({
        where: { provider_externalId: { provider: 'STRIPE', externalId: stripeRefund.id } },
      });
      if (existing) {
        alreadyDone = true;
        return existing;
      }

      const refund = await tx.refund.create({
        data: {
          orderId,
          paymentId: payment.id,
          provider: 'STRIPE',
          status: stripeRefund.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
          amountCents: stripeRefund.amount,
          currency: 'CAD',
          reason: request.reason,
          externalId: stripeRefund.id,
          processedByUserId: request.actor.type === 'admin' ? (request.actor.userId ?? null) : null,
        },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });

      if (request.restock) {
        for (const line of restockLines) {
          if (!line.variantId) continue;
          await tx.inventoryLevel.updateMany({
            where: { variantId: line.variantId },
            data: { quantityOnHand: { increment: line.quantity } },
          });
          await tx.inventoryMovement.create({
            data: {
              variantId: line.variantId,
              type: 'RETURN',
              quantity: line.quantity,
              orderId,
              createdByUserId: request.actor.userId ?? null,
              reason: `Remboursement ${refund.externalId} — commande ${order.number}`,
            },
          });
        }
      }

      // Statut de la commande : une commande ANNULÉE le reste (le
      // remboursement en est la conséquence). Sinon → REFUNDED / PARTIALLY.
      if (order.status !== 'CANCELLED') {
        const target: OrderStatus = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        if (order.status !== target && canTransitionOrder(order.status, target)) {
          await tx.order.update({ where: { id: orderId }, data: { status: target } });
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              fromStatus: order.status,
              toStatus: target,
              changedByUserId: request.actor.userId ?? null,
              note: `${target === 'REFUNDED' ? 'Remboursement total' : 'Remboursement partiel'} (${(stripeRefund.amount / 100).toFixed(2)} $) — ${request.reason}`,
            },
          });
        }
      }

      return refund;
    });

    // 3) Note de crédit (série CRN, PDF) et 4) courriel — TOUS DEUX
    //    idempotents (par refundId / clé d'idempotence). On les exécute même
    //    sur un rejeu (alreadyDone) : cela ferme la course où le webhook
    //    charge.refunded aurait créé la ligne de remboursement avant nous.
    const snapshot = this.creditNoteSnapshot(
      order,
      persisted.amountCents,
      persisted.reason ?? request.reason,
      restockLines,
    );
    const creditNote = await this.invoices.generateCreditNote(persisted.id, orderId, snapshot);

    if (request.notify !== false) {
      await this.orderMail.sendRefunded(
        orderId,
        persisted.id,
        persisted.amountCents,
        creditNote.id,
      );
    }

    if (!alreadyDone) {
      await this.audit.log({
        action: 'order.refunded',
        actorType: request.actor.type,
        actorId: request.actor.userId ?? null,
        entityType: 'order',
        entityId: orderId,
        metadata: {
          number: order.number,
          refundId: persisted.id,
          amountCents: persisted.amountCents,
          fullyRefunded,
          restock: request.restock,
          reason: request.reason,
        },
      });
    }

    const current = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    return {
      refundId: persisted.id,
      amountCents: persisted.amountCents,
      fullyRefunded,
      creditNoteId: creditNote.id,
      orderStatus: current.status,
      alreadyDone,
    };
  }

  /* ------------------------------ Interne ------------------------------ */

  /** Lignes concernées : choisies (par lignes), toutes (total), aucune (par montant). */
  private resolveLines(items: OrderItem[], request: RefundRequest): OrderItem[] {
    if (request.lineItemIds && request.lineItemIds.length > 0) {
      const chosen = items.filter((item) => request.lineItemIds!.includes(item.id));
      if (chosen.length !== request.lineItemIds.length) {
        throw new BadRequestException(
          'Une ou plusieurs lignes sont introuvables sur cette commande.',
        );
      }
      return chosen;
    }
    return request.amountCents !== undefined ? [] : items;
  }

  private resolveAmount(request: RefundRequest, lines: OrderItem[], remaining: number): number {
    if (request.amountCents !== undefined) return request.amountCents;
    if (request.lineItemIds && request.lineItemIds.length > 0) {
      return lines.reduce((sum, line) => sum + line.totalCents, 0);
    }
    return remaining; // remboursement total du restant
  }

  /**
   * Ventile le montant remboursé selon la MÊME composition que la commande
   * (sous-total net, livraison, TPS/TVQ/TVH/TVP) : la note de crédit reflète
   * un « miroir » proportionnel de la facture, taxes ventilées, somme exacte.
   */
  private creditNoteSnapshot(
    order: {
      subtotalCents: number;
      discountCents: number;
      shippingCents: number;
      taxGstCents: number;
      taxQstCents: number;
      taxHstCents: number;
      taxPstCents: number;
      totalCents: number;
    },
    refundAmountCents: number,
    reason: string,
    displayItems: OrderItem[],
  ): CreditNoteSnapshot {
    const netSubtotal = Math.max(order.subtotalCents - order.discountCents, 0);
    const weights = [
      netSubtotal,
      order.shippingCents,
      order.taxGstCents,
      order.taxQstCents,
      order.taxHstCents,
      order.taxPstCents,
    ];
    const [sub, ship, gst, qst, hst, pst] = allocateProportionally(
      Math.min(refundAmountCents, order.totalCents),
      weights,
    );

    const lines: InvoiceLineInput[] | undefined =
      displayItems.length > 0
        ? displayItems.map((item) => ({
            sku: item.sku,
            nameFr: item.nameFr,
            nameEn: item.nameEn,
            nominalLabel: item.nominalLabel,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            discountCents: item.discountCents,
            subtotalCents: item.subtotalCents,
            taxCents: item.taxCents,
            totalCents: item.totalCents,
          }))
        : undefined;

    return {
      subtotalCents: sub!,
      discountCents: 0,
      shippingCents: ship!,
      taxGstCents: gst!,
      taxQstCents: qst!,
      taxHstCents: hst!,
      taxPstCents: pst!,
      totalCents: refundAmountCents,
      reason,
      lines,
    };
  }
}
