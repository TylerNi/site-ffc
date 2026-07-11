import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { MailService } from '../mail/mail.service';
import {
  type AdjustInventoryDto,
  type AdminInventoryItemDto,
  type AdminInventoryMovementDto,
  type AdminInventoryMovementPageDto,
  type AdminInventoryMovementQueryDto,
  type AdminInventoryPageDto,
  type AdminInventoryQueryDto,
  type SetThresholdDto,
} from './dto/admin-inventory.dto';

type VariantWithLevel = Prisma.ProductVariantGetPayload<{
  include: { inventoryLevel: true; product: { include: { translations: true } } };
}>;

/**
 * Inventaire (tâche 10) : niveaux par variante, ajustements TRACÉS (motif
 * obligatoire → `inventory_movements`), seuils d'alerte, alerte courriel au
 * franchissement à la baisse. La ligne de mouvement (qui/quand/pourquoi/delta)
 * EST l'historique exigé par le brief — pas besoin de dupliquer dans l'audit.
 */
@Injectable()
export class AdminInventoryService {
  private readonly logger = new Logger(AdminInventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(query: AdminInventoryQueryDto): Promise<AdminInventoryPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 24;

    let lowStockIds: string[] | undefined;
    if (query.lowStockOnly) {
      const rows = await this.prisma.$queryRaw<Array<{ variant_id: string }>>`
        SELECT variant_id FROM inventory_levels
        WHERE low_stock_threshold IS NOT NULL AND quantity_on_hand <= low_stock_threshold`;
      lowStockIds = rows.map((row) => row.variant_id);
    }

    const where: Prisma.ProductVariantWhereInput = {
      ...(lowStockIds ? { id: { in: lowStockIds } } : {}),
      ...(query.q
        ? {
            OR: [
              { sku: { contains: query.q, mode: 'insensitive' } },
              {
                product: {
                  translations: { some: { name: { contains: query.q, mode: 'insensitive' } } },
                },
              },
            ],
          }
        : {}),
    };

    const [total, variants] = await Promise.all([
      this.prisma.productVariant.count({ where }),
      this.prisma.productVariant.findMany({
        where,
        include: { inventoryLevel: true, product: { include: { translations: true } } },
        orderBy: [{ product: { createdAt: 'desc' } }, { position: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: variants.map((v) => this.toItemDto(v)), total, page, pageSize };
  }

  async setThreshold(variantId: string, dto: SetThresholdDto): Promise<AdminInventoryItemDto> {
    await this.requireVariant(variantId);
    await this.prisma.inventoryLevel.upsert({
      where: { variantId },
      create: { variantId, quantityOnHand: 0, lowStockThreshold: dto.lowStockThreshold },
      update: { lowStockThreshold: dto.lowStockThreshold },
    });
    return this.getItem(variantId);
  }

  async adjust(
    variantId: string,
    actor: User,
    dto: AdjustInventoryDto,
  ): Promise<AdminInventoryItemDto> {
    if (dto.quantity === 0)
      throw new BadRequestException('La quantité doit être différente de zéro.');

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { inventoryLevel: true, product: { include: { translations: true } } },
    });
    if (!variant) throw new NotFoundException('Variante introuvable.');

    const before = variant.inventoryLevel?.quantityOnHand ?? 0;
    const after = before + dto.quantity;
    if (after < 0) {
      throw new BadRequestException('L’ajustement rendrait la quantité en main négative.');
    }

    const [level] = await this.prisma.$transaction([
      this.prisma.inventoryLevel.upsert({
        where: { variantId },
        create: { variantId, quantityOnHand: after },
        update: { quantityOnHand: after },
      }),
      this.prisma.inventoryMovement.create({
        data: {
          variantId,
          type: dto.type,
          quantity: dto.quantity,
          reason: dto.reason,
          createdByUserId: actor.id,
        },
      }),
    ]);

    const threshold = level.lowStockThreshold;
    if (threshold !== null && before > threshold && after <= threshold) {
      await this.sendLowStockAlert(variant, after, threshold);
    }

    return this.getItem(variantId);
  }

  async movements(
    variantId: string,
    query: AdminInventoryMovementQueryDto,
  ): Promise<AdminInventoryMovementPageDto> {
    await this.requireVariant(variantId);
    const limit = query.limit ?? 50;

    const rows = await this.prisma.inventoryMovement.findMany({
      where: { variantId },
      include: { createdByUser: { select: { email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items: AdminInventoryMovementDto[] = rows.slice(0, limit).map((row) => ({
      id: row.id,
      type: row.type,
      quantity: row.quantity,
      reason: row.reason,
      orderId: row.orderId,
      createdByUserId: row.createdByUserId,
      createdByEmail: row.createdByUser?.email ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  private async requireVariant(variantId: string): Promise<void> {
    const count = await this.prisma.productVariant.count({ where: { id: variantId } });
    if (count === 0) throw new NotFoundException('Variante introuvable.');
  }

  private async getItem(variantId: string): Promise<AdminInventoryItemDto> {
    const variant = await this.prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
      include: { inventoryLevel: true, product: { include: { translations: true } } },
    });
    return this.toItemDto(variant);
  }

  private async sendLowStockAlert(
    variant: VariantWithLevel,
    quantityOnHand: number,
    threshold: number,
  ): Promise<void> {
    try {
      const to = this.config.get('INVENTORY_ALERT_EMAIL', { infer: true });
      const adminUrl = this.config.get('APP_ADMIN_URL', { infer: true });
      const productName = pickTranslation(variant.product.translations)?.name ?? variant.sku;
      await this.mail.send({
        to,
        locale: 'fr',
        templateKey: 'inventory_low_stock',
        category: 'TRANSACTIONAL',
        variables: {
          sku: variant.sku,
          productName,
          nominalLabel: variant.nominalLabel,
          quantityOnHand: String(quantityOnHand),
          threshold: String(threshold),
          inventoryUrl: `${adminUrl}/fr/inventaire`,
        },
      });
    } catch (error) {
      this.logger.warn(`Alerte de stock bas non envoyée (${variant.sku})`, error);
    }
  }

  private toItemDto(variant: VariantWithLevel): AdminInventoryItemDto {
    const onHand = variant.inventoryLevel?.quantityOnHand ?? 0;
    const reserved = variant.inventoryLevel?.quantityReserved ?? 0;
    const threshold = variant.inventoryLevel?.lowStockThreshold ?? null;
    return {
      variantId: variant.id,
      sku: variant.sku,
      productId: variant.productId,
      productName: pickTranslation(variant.product.translations)?.name ?? '',
      nominalLabel: variant.nominalLabel,
      quantityOnHand: onHand,
      quantityReserved: reserved,
      availableQuantity: Math.max(onHand - reserved, 0),
      lowStockThreshold: threshold,
      isLowStock: threshold !== null && onHand <= threshold,
    };
  }
}

function pickTranslation<T extends { locale: Locale }>(translations: T[]): T | undefined {
  return translations.find((t) => t.locale === 'fr') ?? translations[0];
}
