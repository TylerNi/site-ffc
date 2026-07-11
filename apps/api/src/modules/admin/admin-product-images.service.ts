import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type ProductImage } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../database';
import {
  type PresignImageUploadResponseDto,
  type PresignImageUploadDto,
  type AdminProductImageDto,
  type RegisterImageDto,
  type ReorderImagesDto,
  type UpdateImageDto,
} from './dto/admin-catalog.dto';
import { PRODUCT_IMAGE_STORAGE, type ProductImageStorage } from './product-image-storage';

/**
 * Images produit (tâche 10) : URL présignée S3 (type + taille validés par S3
 * lui-même), puis « enregistrement » qui relit l'objet pour confirmer que
 * c'est une vraie image et en extraire les dimensions (sharp) avant de
 * créer la ligne `product_images`. Réordonnancement par glisser-déposer
 * (position) et texte alternatif fr/en portés directement par la ligne.
 */
@Injectable()
export class AdminProductImagesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRODUCT_IMAGE_STORAGE) private readonly storage: ProductImageStorage,
  ) {}

  async presignUpload(
    productId: string,
    dto: PresignImageUploadDto,
  ): Promise<PresignImageUploadResponseDto> {
    await this.requireProduct(productId);
    return this.storage.presignUpload({ productId, contentType: dto.contentType });
  }

  async register(productId: string, dto: RegisterImageDto): Promise<AdminProductImageDto> {
    await this.requireProduct(productId);
    if (dto.variantId) await this.requireVariant(productId, dto.variantId);
    if (!dto.key.startsWith(`product-images/${productId}/`)) {
      throw new BadRequestException('Clé d’image invalide pour ce produit.');
    }

    const bytes = await this.storage.fetch(dto.key);
    if (!bytes) {
      throw new BadRequestException('Image introuvable — le téléversement a-t-il abouti ?');
    }

    let metadata: { width?: number; height?: number };
    try {
      metadata = await sharp(bytes).metadata();
    } catch {
      throw new BadRequestException('Fichier invalide : ce n’est pas une image exploitable.');
    }
    if (!metadata.width || !metadata.height) {
      throw new BadRequestException('Fichier invalide : ce n’est pas une image exploitable.');
    }

    const maxPosition = await this.prisma.productImage.aggregate({
      where: { productId },
      _max: { position: true },
    });
    const image = await this.prisma.productImage.create({
      data: {
        productId,
        variantId: dto.variantId ?? null,
        url: dto.key,
        altFr: dto.altFr ?? null,
        altEn: dto.altEn ?? null,
        width: metadata.width,
        height: metadata.height,
        position: (maxPosition._max.position ?? -1) + 1,
      },
    });
    return this.toDto(image);
  }

  async update(
    productId: string,
    imageId: string,
    dto: UpdateImageDto,
  ): Promise<AdminProductImageDto> {
    const existing = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
    });
    if (!existing) throw new NotFoundException('Image introuvable.');
    if (dto.variantId) await this.requireVariant(productId, dto.variantId);

    const image = await this.prisma.productImage.update({
      where: { id: imageId },
      data: {
        ...(dto.altFr !== undefined && { altFr: dto.altFr }),
        ...(dto.altEn !== undefined && { altEn: dto.altEn }),
        ...(dto.variantId !== undefined && { variantId: dto.variantId }),
      },
    });
    return this.toDto(image);
  }

  async remove(productId: string, imageId: string): Promise<void> {
    const existing = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
    });
    if (!existing) throw new NotFoundException('Image introuvable.');
    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.storage.delete(existing.url).catch(() => undefined);
  }

  async reorder(productId: string, dto: ReorderImagesDto): Promise<AdminProductImageDto[]> {
    const images = await this.prisma.productImage.findMany({ where: { productId } });
    const knownIds = new Set(images.map((i) => i.id));
    const sameSet =
      dto.imageIds.length === images.length && dto.imageIds.every((id) => knownIds.has(id));
    if (!sameSet) {
      throw new BadRequestException(
        'La liste doit contenir exactement toutes les images du produit.',
      );
    }

    await this.prisma.$transaction(
      dto.imageIds.map((id, index) =>
        this.prisma.productImage.update({ where: { id }, data: { position: index } }),
      ),
    );
    const reordered = await this.prisma.productImage.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
    });
    return reordered.map((image) => this.toDto(image));
  }

  private async requireProduct(productId: string): Promise<void> {
    const count = await this.prisma.product.count({ where: { id: productId } });
    if (count === 0) throw new NotFoundException('Produit introuvable.');
  }

  private async requireVariant(productId: string, variantId: string): Promise<void> {
    const count = await this.prisma.productVariant.count({ where: { id: variantId, productId } });
    if (count === 0) throw new BadRequestException('Variante introuvable pour ce produit.');
  }

  private toDto(image: ProductImage): AdminProductImageDto {
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
