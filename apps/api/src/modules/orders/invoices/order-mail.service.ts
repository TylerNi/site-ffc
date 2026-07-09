import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Locale, type Order, type OrderItem } from '@prisma/client';
import { formatMoneyCents } from '@ffc/core';
import { type Env } from '../../../config/env';
import { PrismaService } from '../../../database';
import { MailQueueService } from '../../mail/mail-queue.service';
import { InvoiceDownloadTokenService } from './invoice-download-token';

/**
 * Dispatcheur des courriels de commande (tâche 12) : construit les variables
 * bilingues (lignes, montants, liens) et met le courriel en file BullMQ.
 * Toujours idempotent par une clé stable (un webhook/job rejoué → un seul
 * courriel).
 *
 * La langue est TOUJOURS celle du client au moment de l'achat (`order.locale`),
 * jamais celle du serveur.
 */
@Injectable()
export class OrderMailService {
  private readonly logger = new Logger(OrderMailService.name);
  private readonly publicApiUrl: string;
  private readonly webUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailQueue: MailQueueService,
    private readonly downloadToken: InvoiceDownloadTokenService,
    config: ConfigService<Env, true>,
  ) {
    this.publicApiUrl = config.get('PUBLIC_API_URL', { infer: true }).replace(/\/$/, '');
    this.webUrl = config.get('APP_WEB_URL', { infer: true }).replace(/\/$/, '');
  }

  /** Lien signé de téléchargement d'une facture — valide sans session (courriel). */
  invoiceDownloadUrl(invoiceId: string): string {
    const token = this.downloadToken.sign(invoiceId);
    return `${this.publicApiUrl}/v1/invoices/${invoiceId}/download?token=${encodeURIComponent(token)}`;
  }

  /** Page « Mes commandes » (client connecté) / suivi de commande. */
  private orderUrl(order: Pick<Order, 'id' | 'locale'>): string {
    return `${this.webUrl}/${order.locale}/account/orders/${order.id}`;
  }

  /* --------------------------- Confirmation ---------------------------- */

  async sendConfirmation(orderId: string, invoiceId: string): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    const money = (cents: number): string => formatMoneyCents(cents, order.currency, order.locale);

    await this.enqueue(order, 'order_confirmation', `order_confirmation:${orderId}`, {
      orderNumber: order.number,
      total: money(order.totalCents),
      linesText: this.linesText(order.items, order.locale, money),
      linesHtml: this.linesHtml(order.items, order.locale, money),
      invoiceUrl: this.invoiceDownloadUrl(invoiceId),
    });
  }

  /* --------------------------- Paiement échoué ------------------------- */

  async sendPaymentFailed(
    orderId: string,
    reason: string | null,
    idempotencyScope: string,
  ): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    await this.enqueue(order, 'order_payment_failed', `order_payment_failed:${idempotencyScope}`, {
      orderNumber: order.number,
      reason: reason ?? '',
      retryUrl: `${this.webUrl}/${order.locale}/checkout`,
    });
  }

  /* ----------------------------- Annulation ---------------------------- */

  async sendCancelled(orderId: string, refundAmountCents: number | null): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    await this.enqueue(order, 'order_cancelled', `order_cancelled:${orderId}`, {
      orderNumber: order.number,
      refundAmount:
        refundAmountCents && refundAmountCents > 0
          ? formatMoneyCents(refundAmountCents, order.currency, order.locale)
          : '',
    });
  }

  /* --------------------------- Remboursement --------------------------- */

  async sendRefunded(
    orderId: string,
    refundId: string,
    refundAmountCents: number,
    creditNoteInvoiceId: string | null,
  ): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    await this.enqueue(order, 'order_refunded', `order_refunded:${refundId}`, {
      orderNumber: order.number,
      refundAmount: formatMoneyCents(refundAmountCents, order.currency, order.locale),
      creditNoteUrl: creditNoteInvoiceId ? this.invoiceDownloadUrl(creditNoteInvoiceId) : '',
    });
  }

  /* ---------------------- Expédition / livraison ----------------------- */
  // Gabarits PRÊTS (tâche 12) ; l'appel réel est branché par la tâche 14.

  async sendShipped(
    orderId: string,
    info: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null },
  ): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    await this.enqueue(order, 'order_shipped', `order_shipped:${orderId}`, {
      orderNumber: order.number,
      carrier: info.carrier ?? '',
      trackingNumber: info.trackingNumber ?? '',
      trackingUrl: info.trackingUrl ?? '',
    });
  }

  async sendDelivered(orderId: string): Promise<void> {
    const order = await this.loadOrder(orderId);
    if (!order) return;
    await this.enqueue(order, 'order_delivered', `order_delivered:${orderId}`, {
      orderNumber: order.number,
    });
  }

  /* ------------------------------ Interne ------------------------------ */

  private async loadOrder(
    orderId: string,
  ): Promise<(Order & { items: OrderItem[]; email: string | null }) | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, user: { select: { email: true } } },
    });
    if (!order) return null;
    return { ...order, email: order.guestEmail ?? order.user?.email ?? null };
  }

  private async enqueue(
    order: Order & { email: string | null },
    templateKey: Parameters<MailQueueService['enqueue']>[0]['templateKey'],
    idempotencyKey: string,
    variables: Record<string, string>,
  ): Promise<void> {
    if (!order.email) {
      this.logger.warn(`Commande ${order.number} sans courriel — ${templateKey} non envoyé.`);
      return;
    }
    await this.mailQueue.enqueue({
      userId: order.userId,
      to: order.email,
      locale: order.locale,
      templateKey,
      variables,
      category: 'TRANSACTIONAL',
      orderId: order.id,
      idempotencyKey,
    });
  }

  private linesText(items: OrderItem[], locale: Locale, money: (cents: number) => string): string {
    return items
      .map(
        (item) =>
          `  ${item.quantity} × ${locale === 'fr' ? item.nameFr : item.nameEn} — ${money(item.totalCents)}`,
      )
      .join('\n');
  }

  private linesHtml(items: OrderItem[], locale: Locale, money: (cents: number) => string): string {
    return items
      .map(
        (item) =>
          `<div style="display:flex;justify-content:space-between;padding:2px 0;">` +
          `<span>${item.quantity} × ${escapeHtml(locale === 'fr' ? item.nameFr : item.nameEn)}</span>` +
          `<span>${money(item.totalCents)}</span></div>`,
      )
      .join('');
  }
}

/** Échappe le HTML des noms de produits injectés dans les gabarits de courriel. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
