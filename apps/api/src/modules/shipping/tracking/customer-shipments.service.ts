import { Injectable } from '@nestjs/common';
import { type User } from '@prisma/client';
import { carrierLabel, isFinalShipmentStatus, type Locale, shipmentStatusLabel } from '@ffc/core';
import { PrismaService } from '../../../database';
import { type MyShipmentDto, type MyShipmentsPageDto } from './dto/customer-shipments.dto';

/**
 * « Mes colis » (tâche 14) : tous les colis du compte, quel que soit le
 * transporteur — actifs et historique — avec la chronologie normalisée par
 * colis. Strictement limité aux commandes du compte connecté. La même API
 * servira l'app mobile (tâche 19).
 */
@Injectable()
export class CustomerShipmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: User, limit: number, cursor: string | undefined): Promise<MyShipmentsPageDto> {
    const take = limit + 1;
    const shipments = await this.prisma.shipment.findMany({
      where: { order: { userId: user.id } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        order: { select: { id: true, number: true } },
        events: { orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }] },
      },
    });

    const hasMore = shipments.length === take;
    const page = hasMore ? shipments.slice(0, limit) : shipments;
    const locale = user.locale as Locale;

    return {
      items: page.map((shipment): MyShipmentDto => ({
        id: shipment.id,
        orderId: shipment.order.id,
        orderNumber: shipment.order.number,
        carrier: shipment.carrier,
        carrierLabel: shipment.carrier ? carrierLabel(shipment.carrier, locale) : null,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        status: shipment.status,
        statusLabel: shipmentStatusLabel(shipment.status, locale),
        isActive: !isFinalShipmentStatus(shipment.status),
        shippedAt: shipment.shippedAt?.toISOString() ?? null,
        estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
        deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
        events: shipment.events.map((event) => ({
          code: event.code,
          status: event.status,
          statusLabel: event.status ? shipmentStatusLabel(event.status, locale) : null,
          description: event.description,
          location: event.location,
          occurredAt: event.occurredAt.toISOString(),
        })),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
