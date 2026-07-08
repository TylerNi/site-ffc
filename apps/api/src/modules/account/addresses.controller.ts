import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { type CheckoutAddress, checkoutAddressSchema, SHIPPING_COUNTRIES } from '@ffc/core';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../database';
import { CheckoutAddressDto } from '../orders/checkout/dto/checkout.dto';
import { CurrentUser } from '../auth/decorators';

/** Adresse sauvegardée + réglages de défaut. Champs postaux : CheckoutAddressDto. */
class SaveAddressDto extends CheckoutAddressDto {
  @ApiPropertyOptional({ maxLength: 60, description: 'Libellé libre (« Maison », « Chalet »…)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefaultShipping?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefaultBilling?: boolean;
}

class AddressDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  label?: string | null;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  company?: string | null;

  @ApiProperty()
  line1!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  line2?: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  province!: string;

  @ApiProperty()
  postalCode!: string;

  @ApiProperty({ enum: SHIPPING_COUNTRIES })
  country!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  phone?: string | null;

  @ApiProperty()
  isDefaultShipping!: boolean;

  @ApiProperty()
  isDefaultBilling!: boolean;
}

class AddressListDto {
  @ApiProperty({ type: [AddressDto] })
  addresses!: AddressDto[];
}

/**
 * Carnet d'adresses du compte (tâche 11) : mêmes règles de validation
 * CA/US que le checkout (@ffc/core), codes postaux normalisés à l'écriture.
 */
@ApiTags('account')
@ApiBearerAuth()
@Controller('me/addresses')
export class AddressesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Adresses sauvegardées', operationId: 'listMyAddresses' })
  @ApiOkResponse({ type: AddressListDto })
  async list(@CurrentUser() user: User): Promise<AddressListDto> {
    const addresses = await this.prisma.address.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefaultShipping: 'desc' }, { createdAt: 'asc' }],
    });
    return { addresses: addresses.map((address) => this.toDto(address)) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ajoute une adresse au carnet', operationId: 'createMyAddress' })
  @ApiOkResponse({ type: AddressDto })
  async create(@CurrentUser() user: User, @Body() dto: SaveAddressDto): Promise<AddressDto> {
    const address = this.validate(dto);
    const isFirst = (await this.prisma.address.count({ where: { userId: user.id } })) === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(tx, user.id, dto);
      return tx.address.create({
        data: {
          userId: user.id,
          label: dto.label ?? null,
          ...this.toColumns(address),
          isDefaultShipping: dto.isDefaultShipping ?? isFirst,
          isDefaultBilling: dto.isDefaultBilling ?? isFirst,
        },
      });
    });
    return this.toDto(created);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Remplace une adresse du carnet', operationId: 'updateMyAddress' })
  @ApiOkResponse({ type: AddressDto })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveAddressDto,
  ): Promise<AddressDto> {
    await this.requireOwned(user.id, id);
    const address = this.validate(dto);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(tx, user.id, dto, id);
      return tx.address.update({
        where: { id },
        data: {
          label: dto.label ?? null,
          ...this.toColumns(address),
          ...(dto.isDefaultShipping !== undefined && { isDefaultShipping: dto.isDefaultShipping }),
          ...(dto.isDefaultBilling !== undefined && { isDefaultBilling: dto.isDefaultBilling }),
        },
      });
    });
    return this.toDto(updated);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprime une adresse du carnet', operationId: 'deleteMyAddress' })
  async remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.requireOwned(user.id, id);
    await this.prisma.address.delete({ where: { id } });
  }

  /* ------------------------------- Détails ------------------------------ */

  private async requireOwned(userId: string, id: string): Promise<void> {
    const found = await this.prisma.address.findFirst({ where: { id, userId } });
    if (!found) throw new NotFoundException('Adresse introuvable.');
  }

  /** Un seul défaut par usage : poser un défaut retire l'ancien. */
  private async clearDefaults(
    tx: Pick<PrismaService, 'address'>,
    userId: string,
    dto: SaveAddressDto,
    excludeId?: string,
  ): Promise<void> {
    const where = { userId, ...(excludeId && { id: { not: excludeId } }) };
    if (dto.isDefaultShipping) {
      await tx.address.updateMany({ where, data: { isDefaultShipping: false } });
    }
    if (dto.isDefaultBilling) {
      await tx.address.updateMany({ where, data: { isDefaultBilling: false } });
    }
  }

  private validate(dto: SaveAddressDto): CheckoutAddress {
    const parsed = checkoutAddressSchema.safeParse(dto);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_ADDRESS',
        message: 'Adresse invalide.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  private toColumns(address: CheckoutAddress) {
    return {
      firstName: address.firstName,
      lastName: address.lastName,
      company: address.company ?? null,
      line1: address.line1,
      line2: address.line2 ?? null,
      city: address.city,
      province: address.province,
      postalCode: address.postalCode,
      country: address.country,
      phone: address.phone ?? null,
    };
  }

  private toDto(address: {
    id: string;
    label: string | null;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    line1: string;
    line2: string | null;
    city: string;
    province: string;
    postalCode: string;
    country: string;
    phone: string | null;
    isDefaultShipping: boolean;
    isDefaultBilling: boolean;
  }): AddressDto {
    return {
      id: address.id,
      label: address.label,
      firstName: address.firstName ?? '',
      lastName: address.lastName ?? '',
      company: address.company,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      province: address.province,
      postalCode: address.postalCode,
      country: address.country,
      phone: address.phone,
      isDefaultShipping: address.isDefaultShipping,
      isDefaultBilling: address.isDefaultBilling,
    };
  }
}
