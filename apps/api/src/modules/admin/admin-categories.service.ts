import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type Category, type CategoryTranslation } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { PrismaService } from '../../database';
import {
  type AdminCategoryNodeDto,
  type AdminCategoryTreeDto,
  type CreateCategoryDto,
  type MoveCategoryDto,
  type UpdateCategoryDto,
} from './dto/admin-catalog.dto';

type CategoryWithTranslations = Category & {
  translations: CategoryTranslation[];
  _count: { products: number };
};

/**
 * Catégories (tâche 10) : arborescence complète (actives ET inactives — vue
 * admin), traductions fr/en, déplacement avec garde anti-cycle. Pas de
 * suppression dure (comme les marques) : `isActive` suffit à retirer une
 * catégorie de la vitrine sans casser les produits qui y pointent encore
 * (`Product.categoryId` en `SetNull`).
 */
@Injectable()
export class AdminCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async tree(): Promise<AdminCategoryTreeDto> {
    const categories = await this.prisma.category.findMany({
      include: { translations: true, _count: { select: { products: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    return { categories: buildTree(categories, null) };
  }

  async create(dto: CreateCategoryDto): Promise<AdminCategoryNodeDto> {
    if (!dto.translations.fr && !dto.translations.en) {
      throw new BadRequestException('Au moins une traduction (fr ou en) est requise.');
    }
    if (dto.parentId) await this.requireCategory(dto.parentId);
    await this.assertSlugsFree(dto.translations);

    const category = await this.prisma.category.create({
      data: {
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
        translations: {
          create: [
            ...(dto.translations.fr ? [{ locale: 'fr' as Locale, ...dto.translations.fr }] : []),
            ...(dto.translations.en ? [{ locale: 'en' as Locale, ...dto.translations.en }] : []),
          ],
        },
      },
      include: { translations: true, _count: { select: { products: true } } },
    });
    return toNodeDto(category, []);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<AdminCategoryNodeDto> {
    await this.requireCategory(id);
    if (dto.translations) await this.assertSlugsFree(dto.translations, id);

    if (dto.translations?.fr) {
      await this.prisma.categoryTranslation.upsert({
        where: { categoryId_locale: { categoryId: id, locale: 'fr' } },
        create: { categoryId: id, locale: 'fr', ...dto.translations.fr },
        update: { ...dto.translations.fr },
      });
    }
    if (dto.translations?.en) {
      await this.prisma.categoryTranslation.upsert({
        where: { categoryId_locale: { categoryId: id, locale: 'en' } },
        create: { categoryId: id, locale: 'en', ...dto.translations.en },
        update: { ...dto.translations.en },
      });
    }

    const category = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: { translations: true, _count: { select: { products: true } } },
    });
    return toNodeDto(category, []);
  }

  async move(id: string, dto: MoveCategoryDto): Promise<void> {
    await this.requireCategory(id);
    const parentId = dto.parentId ?? null;

    if (parentId) {
      if (parentId === id) {
        throw new BadRequestException('Une catégorie ne peut pas être son propre parent.');
      }
      let cursor: string | null = parentId;
      while (cursor) {
        if (cursor === id) {
          throw new BadRequestException('Déplacement invalide : créerait un cycle.');
        }
        const parent: { parentId: string | null } | null = await this.prisma.category.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
        if (!parent) throw new BadRequestException('Catégorie parente introuvable.');
        cursor = parent.parentId;
      }
    }

    await this.prisma.category.update({ where: { id }, data: { parentId } });
  }

  private async requireCategory(id: string): Promise<void> {
    const count = await this.prisma.category.count({ where: { id } });
    if (count === 0) throw new NotFoundException('Catégorie introuvable.');
  }

  private async assertSlugsFree(
    translations: { fr?: { slug: string }; en?: { slug: string } },
    excludeCategoryId?: string,
  ): Promise<void> {
    for (const [locale, input] of Object.entries(translations) as [
      Locale,
      { slug: string } | undefined,
    ][]) {
      if (!input) continue;
      const clash = await this.prisma.categoryTranslation.findUnique({
        where: { locale_slug: { locale, slug: input.slug } },
      });
      if (clash && clash.categoryId !== excludeCategoryId) {
        throw new BadRequestException(`Le slug « ${input.slug} » est déjà utilisé (${locale}).`);
      }
    }
  }
}

function toNodeDto(
  category: CategoryWithTranslations,
  children: AdminCategoryNodeDto[],
): AdminCategoryNodeDto {
  return {
    id: category.id,
    parentId: category.parentId,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    productCount: category._count.products,
    translations: category.translations.map((t) => ({
      locale: t.locale,
      name: t.name,
      slug: t.slug,
      description: t.description,
    })),
    children,
  };
}

function buildTree(
  categories: CategoryWithTranslations[],
  parentId: string | null,
): AdminCategoryNodeDto[] {
  return categories
    .filter((c) => c.parentId === parentId)
    .map((category) => toNodeDto(category, buildTree(categories, category.id)));
}
