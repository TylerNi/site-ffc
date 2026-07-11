import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type ProductImage,
  type ProductTranslation,
  type ProductVariant,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { type Locale } from '@ffc/core';
import { PrismaService } from '../../database';
import { RevalidationClient } from '../catalog/revalidation.client';
import {
  type AdminBrandRefDto,
  type AdminCategoryRefDto,
  type AdminInventorySummaryDto,
  type AdminProductDetailDto,
  type AdminProductImageDto,
  type AdminProductListDto,
  type AdminProductListItemDto,
  type AdminProductListQueryDto,
  type AdminProductTranslationDto,
  type AdminVariantDto,
  type CreateProductDto,
  type CreateVariantDto,
  type UpdateProductDto,
  type UpdateVariantDto,
  type UpsertProductTranslationDto,
} from './dto/admin-catalog.dto';
import { SizeService } from '../catalog/size.service';

const DETAIL_INCLUDE = {
  brand: true,
  category: { include: { translations: true } },
  translations: true,
  variants: { include: { inventoryLevel: true }, orderBy: { position: 'asc' as const } },
  images: { orderBy: { position: 'asc' as const } },
} satisfies Prisma.ProductInclude;

type ProductWithDetail = Prisma.ProductGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const LIST_INCLUDE = {
  brand: true,
  category: { include: { translations: true } },
  translations: true,
  images: { orderBy: { position: 'asc' as const }, take: 1 },
  variants: { select: { priceCents: true }, orderBy: { priceCents: 'asc' as const }, take: 1 },
  _count: { select: { variants: true } },
} satisfies Prisma.ProductInclude;

type ProductListRow = Prisma.ProductGetPayload<{ include: typeof LIST_INCLUDE }>;

/**
 * Produits, traductions et variantes (tâche 10). Les mutations passent
 * toutes par `/v1/admin/products` — validées, RBAC (`products.*`), auditées
 * automatiquement par `AdminAuditInterceptor`. Pas de step-up : ce sont des
 * opérations de catalogue courantes, pas des actions sensibles (réservé au
 * step-up dans la tâche 09 : remboursements, changements de rôles…).
 */
@Injectable()
export class AdminProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly size: SizeService,
    private readonly revalidation: RevalidationClient,
  ) {}

  /* ---------------------------------- Liste ---------------------------------- */

  async list(query: AdminProductListQueryDto): Promise<AdminProductListDto> {
    const limit = query.limit ?? 24;
    const where = await this.buildWhere(query);

    const rows = await this.prisma.product.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((product) => this.toListItemDto(product)),
      hasMore,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  private async buildWhere(query: AdminProductListQueryDto): Promise<Prisma.ProductWhereInput> {
    const and: Prisma.ProductWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.brandId) and.push({ brandId: query.brandId });
    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.merv !== undefined) and.push({ variants: { some: { merv: query.merv } } });
    if (query.dimension) {
      const labels = [...this.size.resolve(query.dimension).labels];
      and.push({ variants: { some: { nominalLabel: { in: labels } } } });
    }
    if (query.q) {
      and.push({
        OR: [
          { translations: { some: { name: { contains: query.q, mode: 'insensitive' } } } },
          { variants: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
        ],
      });
    }
    return and.length > 0 ? { AND: and } : {};
  }

  /* --------------------------------- Fiche ------------------------------- */

  async get(id: string): Promise<AdminProductDetailDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!product) throw new NotFoundException('Produit introuvable.');
    return this.toDetailDto(product);
  }

  private async requireProduct(id: string): Promise<ProductWithDetail> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!product) throw new NotFoundException('Produit introuvable.');
    return product;
  }

  /* -------------------------------- Mutations ------------------------------ */

  async create(dto: CreateProductDto): Promise<AdminProductDetailDto> {
    await this.assertBrandExists(dto.brandId);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const product = await this.prisma.product.create({
      data: {
        brandId: dto.brandId,
        categoryId: dto.categoryId ?? null,
        isFeatured: dto.isFeatured ?? false,
        status: 'DRAFT',
      },
    });
    return this.get(product.id);
  }

  async update(id: string, dto: UpdateProductDto): Promise<AdminProductDetailDto> {
    await this.requireProduct(id);
    if (dto.brandId !== undefined) await this.assertBrandExists(dto.brandId);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.brandId !== undefined && { brandId: dto.brandId }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
        ...(dto.isFeatured !== undefined && { isFeatured: dto.isFeatured }),
      },
    });
    return this.get(id);
  }

  async duplicate(id: string): Promise<AdminProductDetailDto> {
    const original = await this.requireProduct(id);

    const newId = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          brandId: original.brandId,
          categoryId: original.categoryId,
          isFeatured: false,
          status: 'DRAFT',
        },
      });

      for (const translation of original.translations) {
        const slug = await this.uniqueSlug(tx, translation.locale, `${translation.slug}-copie`);
        await tx.productTranslation.create({
          data: {
            productId: product.id,
            locale: translation.locale,
            name: translation.name,
            slug,
            shortDescription: translation.shortDescription,
            description: translation.description,
            metaTitle: null,
            metaDescription: null,
          },
        });
      }

      const variantIdMap = new Map<string, string>();
      for (const variant of original.variants) {
        const sku = await this.uniqueSku(tx, `${variant.sku}-COPIE`);
        const newVariant = await tx.productVariant.create({
          data: {
            productId: product.id,
            sku,
            nominalLabel: variant.nominalLabel,
            nominalWidthIn: variant.nominalWidthIn,
            nominalHeightIn: variant.nominalHeightIn,
            nominalDepthIn: variant.nominalDepthIn,
            actualWidthIn: variant.actualWidthIn,
            actualHeightIn: variant.actualHeightIn,
            actualDepthIn: variant.actualDepthIn,
            merv: variant.merv,
            packSize: variant.packSize,
            priceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            costCents: variant.costCents,
            currency: variant.currency,
            weightGrams: variant.weightGrams,
            isActive: variant.isActive,
            position: variant.position,
          },
        });
        variantIdMap.set(variant.id, newVariant.id);
        await tx.inventoryLevel.create({ data: { variantId: newVariant.id, quantityOnHand: 0 } });
      }

      for (const image of original.images) {
        await tx.productImage.create({
          data: {
            productId: product.id,
            variantId: image.variantId ? (variantIdMap.get(image.variantId) ?? null) : null,
            url: image.url,
            altFr: image.altFr,
            altEn: image.altEn,
            width: image.width,
            height: image.height,
            position: image.position,
          },
        });
      }

      return product.id;
    });

    return this.get(newId);
  }

  /* ------------------------------- Publication ------------------------------ */

  async publish(id: string): Promise<AdminProductDetailDto> {
    const product = await this.requireProduct(id);
    if (product.translations.length === 0) {
      throw new BadRequestException('Au moins une traduction est requise avant publication.');
    }
    if (product.variants.length === 0) {
      throw new BadRequestException('Au moins une variante est requise avant publication.');
    }
    await this.prisma.product.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.revalidateFor(product.translations);
    return this.get(id);
  }

  async unpublish(id: string): Promise<AdminProductDetailDto> {
    const product = await this.requireProduct(id);
    await this.prisma.product.update({ where: { id }, data: { status: 'DRAFT' } });
    await this.revalidateFor(product.translations);
    return this.get(id);
  }

  async archive(id: string): Promise<AdminProductDetailDto> {
    const product = await this.requireProduct(id);
    await this.prisma.product.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await this.revalidateFor(product.translations);
    return this.get(id);
  }

  async restore(id: string): Promise<AdminProductDetailDto> {
    const product = await this.requireProduct(id);
    if (product.status !== 'ARCHIVED') {
      throw new BadRequestException('Seul un produit archivé peut être restauré.');
    }
    await this.prisma.product.update({ where: { id }, data: { status: 'DRAFT' } });
    await this.revalidateFor(product.translations);
    return this.get(id);
  }

  private async revalidateFor(
    translations: Array<{ locale: Locale; slug: string }>,
  ): Promise<void> {
    const tags = ['products', ...translations.map((t) => `product:${t.locale}:${t.slug}`)];
    await this.revalidation.revalidate(tags);
  }

  /* ------------------------------- Traductions ------------------------------- */

  async upsertTranslation(
    productId: string,
    locale: Locale,
    dto: UpsertProductTranslationDto,
  ): Promise<AdminProductDetailDto> {
    await this.requireProduct(productId);
    const clash = await this.prisma.productTranslation.findUnique({
      where: { locale_slug: { locale, slug: dto.slug } },
    });
    if (clash && clash.productId !== productId) {
      throw new ConflictException(`Le slug « ${dto.slug} » est déjà utilisé (${locale}).`);
    }

    try {
      await this.prisma.productTranslation.upsert({
        where: { productId_locale: { productId, locale } },
        create: {
          productId,
          locale,
          name: dto.name,
          slug: dto.slug,
          shortDescription: dto.shortDescription ?? null,
          description: dto.description ?? null,
          metaTitle: dto.metaTitle ?? null,
          metaDescription: dto.metaDescription ?? null,
        },
        update: {
          name: dto.name,
          slug: dto.slug,
          shortDescription: dto.shortDescription ?? null,
          description: dto.description ?? null,
          metaTitle: dto.metaTitle ?? null,
          metaDescription: dto.metaDescription ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Le slug « ${dto.slug} » est déjà utilisé (${locale}).`);
      }
      throw error;
    }
    return this.get(productId);
  }

  /* --------------------------------- Variantes -------------------------------- */

  async createVariant(productId: string, dto: CreateVariantDto): Promise<AdminVariantDto> {
    await this.requireProduct(productId);
    const maxPosition = await this.prisma.productVariant.aggregate({
      where: { productId },
      _max: { position: true },
    });

    try {
      const variant = await this.prisma.productVariant.create({
        data: {
          productId,
          sku: dto.sku,
          barcode: dto.barcode ?? null,
          nominalLabel: dto.nominalLabel,
          nominalWidthIn: dto.nominalWidthIn,
          nominalHeightIn: dto.nominalHeightIn,
          nominalDepthIn: dto.nominalDepthIn,
          actualWidthIn: dto.actualWidthIn,
          actualHeightIn: dto.actualHeightIn,
          actualDepthIn: dto.actualDepthIn,
          merv: dto.merv ?? null,
          packSize: dto.packSize ?? 1,
          priceCents: dto.priceCents,
          compareAtPriceCents: dto.compareAtPriceCents ?? null,
          costCents: dto.costCents ?? null,
          currency: dto.currency ?? 'CAD',
          weightGrams: dto.weightGrams ?? null,
          position: (maxPosition._max.position ?? -1) + 1,
        },
      });
      await this.prisma.inventoryLevel.create({
        data: { variantId: variant.id, quantityOnHand: 0 },
      });
      return this.toVariantDto({
        ...variant,
        inventoryLevel: { quantityOnHand: 0, quantityReserved: 0, lowStockThreshold: null },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Le SKU « ${dto.sku} » est déjà utilisé.`);
      }
      throw error;
    }
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<AdminVariantDto> {
    const existing = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
    });
    if (!existing) throw new NotFoundException('Variante introuvable.');

    try {
      const updated = await this.prisma.productVariant.update({
        where: { id: variantId },
        data: {
          ...(dto.sku !== undefined && { sku: dto.sku }),
          ...(dto.barcode !== undefined && { barcode: dto.barcode }),
          ...(dto.nominalLabel !== undefined && { nominalLabel: dto.nominalLabel }),
          ...(dto.nominalWidthIn !== undefined && { nominalWidthIn: dto.nominalWidthIn }),
          ...(dto.nominalHeightIn !== undefined && { nominalHeightIn: dto.nominalHeightIn }),
          ...(dto.nominalDepthIn !== undefined && { nominalDepthIn: dto.nominalDepthIn }),
          ...(dto.actualWidthIn !== undefined && { actualWidthIn: dto.actualWidthIn }),
          ...(dto.actualHeightIn !== undefined && { actualHeightIn: dto.actualHeightIn }),
          ...(dto.actualDepthIn !== undefined && { actualDepthIn: dto.actualDepthIn }),
          ...(dto.merv !== undefined && { merv: dto.merv }),
          ...(dto.packSize !== undefined && { packSize: dto.packSize }),
          ...(dto.priceCents !== undefined && { priceCents: dto.priceCents }),
          ...(dto.compareAtPriceCents !== undefined && {
            compareAtPriceCents: dto.compareAtPriceCents,
          }),
          ...(dto.costCents !== undefined && { costCents: dto.costCents }),
          ...(dto.currency !== undefined && { currency: dto.currency }),
          ...(dto.weightGrams !== undefined && { weightGrams: dto.weightGrams }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
        include: { inventoryLevel: true },
      });
      return this.toVariantDto(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Le SKU « ${dto.sku} » est déjà utilisé.`);
      }
      throw error;
    }
  }

  async deleteVariant(productId: string, variantId: string): Promise<void> {
    const existing = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId },
      include: { _count: { select: { orderItems: true } } },
    });
    if (!existing) throw new NotFoundException('Variante introuvable.');
    if (existing._count.orderItems > 0) {
      throw new ConflictException(
        'Cette variante a déjà été commandée — impossible à supprimer (désactivez-la plutôt).',
      );
    }
    await this.prisma.productVariant.delete({ where: { id: variantId } });
  }

  /* --------------------------------- Aides ------------------------------- */

  private async assertBrandExists(brandId: string): Promise<void> {
    const count = await this.prisma.brand.count({ where: { id: brandId } });
    if (count === 0) throw new BadRequestException('Marque introuvable.');
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const count = await this.prisma.category.count({ where: { id: categoryId } });
    if (count === 0) throw new BadRequestException('Catégorie introuvable.');
  }

  private async uniqueSlug(
    tx: Prisma.TransactionClient,
    locale: Locale,
    base: string,
  ): Promise<string> {
    let candidate = base;
    for (let attempt = 0; ; attempt += 1) {
      const clash = await tx.productTranslation.findUnique({
        where: { locale_slug: { locale, slug: candidate } },
      });
      if (!clash) return candidate;
      candidate = `${base}-${randomUUID().slice(0, 4)}`;
      if (attempt > 5) return `${base}-${randomUUID()}`;
    }
  }

  private async uniqueSku(tx: Prisma.TransactionClient, base: string): Promise<string> {
    let candidate = base;
    for (let attempt = 0; ; attempt += 1) {
      const clash = await tx.productVariant.findUnique({ where: { sku: candidate } });
      if (!clash) return candidate;
      candidate = `${base}-${randomUUID().slice(0, 4).toUpperCase()}`;
      if (attempt > 5) return `${base}-${randomUUID().toUpperCase()}`;
    }
  }

  /* ------------------------------- Mappers ------------------------------- */

  private toListItemDto(product: ProductListRow): AdminProductListItemDto {
    return {
      id: product.id,
      status: product.status,
      isFeatured: product.isFeatured,
      brand: this.brandRef(product.brand),
      category: this.categoryRef(product.category),
      translatedLocales: product.translations.map((t) => t.locale),
      name: pickTranslation(product.translations)?.name ?? '(sans nom)',
      image: product.images[0] ? this.toImageDto(product.images[0]) : null,
      variantCount: product._count.variants,
      priceFromCents: product.variants[0]?.priceCents ?? null,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  private toDetailDto(product: ProductWithDetail): AdminProductDetailDto {
    return {
      id: product.id,
      status: product.status,
      isFeatured: product.isFeatured,
      brand: this.brandRef(product.brand),
      category: this.categoryRef(product.category),
      translations: product.translations.map((t) => this.toTranslationDto(t)),
      variants: product.variants.map((v) => this.toVariantDto(v)),
      images: product.images.map((i) => this.toImageDto(i)),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  private brandRef(brand: { id: string; slug: string; name: string }): AdminBrandRefDto {
    return { id: brand.id, slug: brand.slug, name: brand.name };
  }

  private categoryRef(
    category: { id: string; translations: { locale: Locale; name: string }[] } | null,
  ): AdminCategoryRefDto | null {
    if (!category) return null;
    return { id: category.id, name: pickTranslation(category.translations)?.name ?? null };
  }

  private toTranslationDto(translation: ProductTranslation): AdminProductTranslationDto {
    return {
      locale: translation.locale,
      name: translation.name,
      slug: translation.slug,
      shortDescription: translation.shortDescription,
      description: translation.description,
      metaTitle: translation.metaTitle,
      metaDescription: translation.metaDescription,
    };
  }

  private toVariantDto(
    variant: ProductVariant & {
      inventoryLevel: {
        quantityOnHand: number;
        quantityReserved: number;
        lowStockThreshold: number | null;
      } | null;
    },
  ): AdminVariantDto {
    return {
      id: variant.id,
      sku: variant.sku,
      barcode: variant.barcode,
      nominalLabel: variant.nominalLabel,
      nominalWidthIn: Number(variant.nominalWidthIn),
      nominalHeightIn: Number(variant.nominalHeightIn),
      nominalDepthIn: Number(variant.nominalDepthIn),
      actualWidthIn: Number(variant.actualWidthIn),
      actualHeightIn: Number(variant.actualHeightIn),
      actualDepthIn: Number(variant.actualDepthIn),
      merv: variant.merv,
      packSize: variant.packSize,
      priceCents: variant.priceCents,
      compareAtPriceCents: variant.compareAtPriceCents,
      costCents: variant.costCents,
      currency: variant.currency,
      weightGrams: variant.weightGrams,
      isActive: variant.isActive,
      position: variant.position,
      inventory: variant.inventoryLevel
        ? ({
            quantityOnHand: variant.inventoryLevel.quantityOnHand,
            quantityReserved: variant.inventoryLevel.quantityReserved,
            lowStockThreshold: variant.inventoryLevel.lowStockThreshold,
          } satisfies AdminInventorySummaryDto)
        : null,
    };
  }

  private toImageDto(image: ProductImage): AdminProductImageDto {
    return {
      id: image.id,
      url: image.url,
      altFr: image.altFr,
      altEn: image.altEn,
      width: image.width,
      height: image.height,
      position: image.position,
      variantId: image.variantId,
    };
  }
}

/** Traduction préférée pour un affichage synthétique (fr d'abord, sinon la première). */
function pickTranslation<T extends { locale: Locale }>(
  translations: T[],
  preferred: Locale = 'fr',
): T | undefined {
  return translations.find((t) => t.locale === preferred) ?? translations[0];
}
