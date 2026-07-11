import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Brand } from '@prisma/client';
import { PrismaService } from '../../database';
import {
  type AdminBrandDto,
  type CreateBrandDto,
  type UpdateBrandDto,
} from './dto/admin-catalog.dto';

/** Marques (tâche 10) : CRUD simple, pas de suppression dure (isActive). */
@Injectable()
export class AdminBrandsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminBrandDto[]> {
    const brands = await this.prisma.brand.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    });
    return brands.map((brand) => this.toDto(brand));
  }

  async create(dto: CreateBrandDto): Promise<AdminBrandDto> {
    try {
      const brand = await this.prisma.brand.create({
        data: { slug: dto.slug, name: dto.name, logoUrl: dto.logoUrl ?? null },
        include: { _count: { select: { products: true } } },
      });
      return this.toDto(brand);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Le slug « ${dto.slug} » est déjà utilisé.`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateBrandDto): Promise<AdminBrandDto> {
    const exists = await this.prisma.brand.count({ where: { id } });
    if (exists === 0) throw new NotFoundException('Marque introuvable.');
    try {
      const brand = await this.prisma.brand.update({
        where: { id },
        data: {
          ...(dto.slug !== undefined && { slug: dto.slug }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
        include: { _count: { select: { products: true } } },
      });
      return this.toDto(brand);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Le slug « ${dto.slug} » est déjà utilisé.`);
      }
      throw error;
    }
  }

  private toDto(brand: Brand & { _count: { products: number } }): AdminBrandDto {
    return {
      id: brand.id,
      slug: brand.slug,
      name: brand.name,
      logoUrl: brand.logoUrl,
      isActive: brand.isActive,
      productCount: brand._count.products,
    };
  }
}
