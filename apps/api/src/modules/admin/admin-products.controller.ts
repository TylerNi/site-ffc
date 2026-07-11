import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { LOCALES, type Locale } from '@ffc/core';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminProductsService } from './admin-products.service';
import {
  AdminProductDetailDto,
  AdminProductListDto,
  AdminProductListQueryDto,
  AdminVariantDto,
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
  UpsertProductTranslationDto,
} from './dto/admin-catalog.dto';
import { LocaleParamPipe } from './locale-param.pipe';

/**
 * Produits, variantes et traductions (tâche 10). Lecture : `products.read`.
 * Écriture : `products.write` (pas de step-up — voir admin-products.service.ts).
 */
@AdminGuarded()
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Get()
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Liste des produits (recherche, filtres)',
    operationId: 'adminListProducts',
  })
  @ApiOkResponse({ type: AdminProductListDto })
  list(@Query() query: AdminProductListQueryDto): Promise<AdminProductListDto> {
    return this.products.list(query);
  }

  @Get(':id')
  @RequirePermissions('products.read')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Fiche produit complète', operationId: 'adminGetProduct' })
  @ApiOkResponse({ type: AdminProductDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.get(id);
  }

  @Post()
  @RequirePermissions('products.write')
  @ApiOperation({ summary: 'Crée un produit (brouillon)', operationId: 'adminCreateProduct' })
  @ApiOkResponse({ type: AdminProductDetailDto })
  create(@Body() dto: CreateProductDto): Promise<AdminProductDetailDto> {
    return this.products.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Modifie marque/catégorie/vedette', operationId: 'adminUpdateProduct' })
  @ApiOkResponse({ type: AdminProductDetailDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<AdminProductDetailDto> {
    return this.products.update(id, dto);
  }

  @Post(':id/duplicate')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Duplique un produit comme gabarit (brouillon, slugs/SKU renommés)',
    operationId: 'adminDuplicateProduct',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  duplicate(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.duplicate(id);
  }

  @Post(':id/publish')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Publie le produit (revalidation ISR de la vitrine)',
    operationId: 'adminPublishProduct',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  publish(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.publish(id);
  }

  @Post(':id/unpublish')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Repasse le produit en brouillon',
    operationId: 'adminUnpublishProduct',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  unpublish(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.unpublish(id);
  }

  @Post(':id/archive')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Archive le produit (jamais de suppression dure)',
    operationId: 'adminArchiveProduct',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  archive(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.archive(id);
  }

  @Post(':id/restore')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Restaure un produit archivé en brouillon',
    operationId: 'adminRestoreProduct',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  restore(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductDetailDto> {
    return this.products.restore(id);
  }

  @Patch(':id/translations/:locale')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'locale', enum: LOCALES })
  @ApiOperation({
    summary: 'Crée ou remplace la traduction d’une locale',
    operationId: 'adminUpsertProductTranslation',
  })
  @ApiOkResponse({ type: AdminProductDetailDto })
  upsertTranslation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locale', LocaleParamPipe) locale: Locale,
    @Body() dto: UpsertProductTranslationDto,
  ): Promise<AdminProductDetailDto> {
    return this.products.upsertTranslation(id, locale, dto);
  }

  @Post(':id/variants')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Ajoute une variante', operationId: 'adminCreateVariant' })
  @ApiOkResponse({ type: AdminVariantDto })
  createVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
  ): Promise<AdminVariantDto> {
    return this.products.createVariant(id, dto);
  }

  @Patch(':id/variants/:variantId')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({ summary: 'Modifie une variante', operationId: 'adminUpdateVariant' })
  @ApiOkResponse({ type: AdminVariantDto })
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
  ): Promise<AdminVariantDto> {
    return this.products.updateVariant(id, variantId, dto);
  }

  @Delete(':id/variants/:variantId')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({
    summary: 'Supprime une variante jamais commandée',
    operationId: 'adminDeleteVariant',
  })
  deleteVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<void> {
    return this.products.deleteVariant(id, variantId);
  }
}
