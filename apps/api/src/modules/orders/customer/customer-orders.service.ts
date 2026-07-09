import { Injectable, NotFoundException } from '@nestjs/common';
import { type Order, type User } from '@prisma/client';
import { isClientCancellable, orderStatusLabel } from '@ffc/core';
import { PrismaService } from '../../../database';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { InvoiceService } from '../invoices/invoice.service';
import {
  type CancelOrderResponseDto,
  type MyOrderDetailDto,
  type MyOrderListItemDto,
  type MyOrdersPageDto,
  type OrderStatusEventDto,
} from './dto/customer-orders.dto';

type AddressSnap = {
  firstName?: string;
  lastName?: string;
  company?: string | null;
  line1?: string;
  line2?: string | null;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
  phone?: string | null;
};

/**
 * Espace « Mes commandes » du client (tâche 12) : liste, détail avec
 * chronologie datée, annulation avant expédition, téléchargement de facture.
 * Toutes les lectures sont STRICTEMENT limitées aux commandes du compte
 * connecté (jamais celles d'autrui).
 */
@Injectable()
export class CustomerOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly invoices: InvoiceService,
  ) {}

  async list(user: User, limit: number, cursor: string | undefined): Promise<MyOrdersPageDto> {
    const take = limit + 1;
    const orders = await this.prisma.order.findMany({
      where: { userId: user.id },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        items: { select: { quantity: true } },
        invoices: { where: { kind: 'INVOICE' }, select: { id: true }, take: 1 },
      },
    });

    const hasMore = orders.length === take;
    const page = hasMore ? orders.slice(0, limit) : orders;
    const locale = user.locale;

    return {
      items: page.map((order): MyOrderListItemDto => ({
        id: order.id,
        number: order.number,
        status: order.status,
        statusLabel: orderStatusLabel(order.status, locale),
        placedAt: order.placedAt.toISOString(),
        currency: order.currency,
        totalCents: order.totalCents,
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        canCancel: isClientCancellable(order.status),
        hasInvoice: order.invoices.length > 0,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async detail(user: User, orderId: string): Promise<MyOrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        coupon: { select: { code: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: {
          where: {
            provider: 'STRIPE',
            status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        refunds: {
          where: { status: { in: ['SUCCEEDED', 'PENDING'] } },
          orderBy: { createdAt: 'asc' },
        },
        invoices: { where: { kind: 'INVOICE' }, select: { number: true }, take: 1 },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    this.assertOwnership(order, user);

    const locale = user.locale;
    const address = (order.shippingAddress as AddressSnap | null) ?? {};
    const payment = order.payments[0] ?? null;

    return {
      id: order.id,
      number: order.number,
      status: order.status,
      statusLabel: orderStatusLabel(order.status, locale),
      placedAt: order.placedAt.toISOString(),
      currency: order.currency,
      lines: order.items.map((item) => ({
        sku: item.sku,
        nameFr: item.nameFr,
        nameEn: item.nameEn,
        nominalLabel: item.nominalLabel,
        packSize: item.packSize,
        merv: item.merv,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountCents: item.discountCents,
        subtotalCents: item.subtotalCents,
        taxCents: item.taxCents,
        totalCents: item.totalCents,
      })),
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      shippingCents: order.shippingCents,
      taxGstCents: order.taxGstCents,
      taxQstCents: order.taxQstCents,
      taxHstCents: order.taxHstCents,
      taxPstCents: order.taxPstCents,
      totalTaxCents: order.taxGstCents + order.taxQstCents + order.taxHstCents + order.taxPstCents,
      totalCents: order.totalCents,
      couponCode: order.coupon?.code ?? null,
      shippingAddress: {
        firstName: address.firstName ?? '',
        lastName: address.lastName ?? '',
        company: address.company ?? null,
        line1: address.line1 ?? '',
        line2: address.line2 ?? null,
        city: address.city ?? '',
        province: address.province ?? '',
        postalCode: address.postalCode ?? '',
        country: address.country === 'US' ? 'US' : 'CA',
        phone: address.phone ?? null,
      },
      cardBrand: payment?.cardBrand ?? null,
      cardLast4: payment?.cardLast4 ?? null,
      timeline: order.statusHistory.map((event): OrderStatusEventDto => ({
        status: event.toStatus,
        label: orderStatusLabel(event.toStatus, locale),
        note: event.note,
        actor: actorOf(event.changedByUserId, order.userId),
        at: event.createdAt.toISOString(),
      })),
      refunds: order.refunds.map((refund) => ({
        amountCents: refund.amountCents,
        at: refund.createdAt.toISOString(),
        reason: refund.reason,
      })),
      invoiceNumber: order.invoices[0]?.number ?? null,
      hasInvoice: order.invoices.length > 0,
      canCancel: isClientCancellable(order.status),
    };
  }

  async cancel(user: User, orderId: string): Promise<CancelOrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    this.assertOwnership(order, user);

    const outcome = await this.lifecycle.cancelByClient(orderId, user.id);
    return { status: outcome.status, refundAmountCents: outcome.refundAmountCents };
  }

  /** Octets de la facture d'une commande du client (endpoint authentifié). */
  async invoicePdf(user: User, orderId: string): Promise<{ number: string; body: Buffer }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    this.assertOwnership(order, user);

    const invoice = await this.prisma.invoice.findFirst({
      where: { orderId, kind: 'INVOICE' },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundException('Facture non disponible pour cette commande.');

    const pdf = await this.invoices.fetchPdf(invoice.id);
    if (!pdf) throw new NotFoundException('Facture en préparation — réessayez dans un instant.');
    return pdf;
  }

  private assertOwnership(order: Pick<Order, 'userId'>, user: User): void {
    if (order.userId !== user.id) {
      // 404 plutôt que 403 : ne pas révéler l'existence de la commande d'autrui.
      throw new NotFoundException('Commande introuvable.');
    }
  }
}

function actorOf(
  changedByUserId: string | null,
  orderUserId: string | null,
): 'client' | 'admin' | 'system' {
  if (!changedByUserId) return 'system';
  if (orderUserId && changedByUserId === orderUserId) return 'client';
  return 'admin';
}
