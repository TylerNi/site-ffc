import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminProductImagesService } from './admin-product-images.service';
import {
  AdminProductImageDto,
  PresignImageUploadDto,
  PresignImageUploadResponseDto,
  RegisterImageDto,
  ReorderImagesDto,
  UpdateImageDto,
} from './dto/admin-catalog.dto';

/** Images produit (tâche 10) : URL présignée, enregistrement, réordonnancement. */
@AdminGuarded()
@Controller('admin/products/:productId/images')
export class AdminProductImagesController {
  constructor(private readonly images: AdminProductImagesService) {}

  @Post('upload-url')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOperation({
    summary: 'URL présignée S3 (type + taille validés côté S3)',
    operationId: 'adminPresignProductImage',
  })
  @ApiOkResponse({ type: PresignImageUploadResponseDto })
  presign(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: PresignImageUploadDto,
  ): Promise<PresignImageUploadResponseDto> {
    return this.images.presignUpload(productId, dto);
  }

  @Post()
  @RequirePermissions('products.write')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOperation({
    summary: 'Enregistre l’image téléversée (valide + extrait les dimensions)',
    operationId: 'adminRegisterProductImage',
  })
  @ApiOkResponse({ type: AdminProductImageDto })
  register(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: RegisterImageDto,
  ): Promise<AdminProductImageDto> {
    return this.images.register(productId, dto);
  }

  @Patch(':imageId')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiOperation({
    summary: 'Modifie le texte alternatif / la variante liée',
    operationId: 'adminUpdateProductImage',
  })
  @ApiOkResponse({ type: AdminProductImageDto })
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: UpdateImageDto,
  ): Promise<AdminProductImageDto> {
    return this.images.update(productId, imageId, dto);
  }

  @Delete(':imageId')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiOperation({ summary: 'Supprime une image', operationId: 'adminDeleteProductImage' })
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    return this.images.remove(productId, imageId);
  }

  @Put('order')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOperation({
    summary: 'Réordonnance les images (glisser-déposer) — la position 0 est l’image principale',
    operationId: 'adminReorderProductImages',
  })
  @ApiOkResponse({ type: [AdminProductImageDto] })
  reorder(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: ReorderImagesDto,
  ): Promise<AdminProductImageDto[]> {
    return this.images.reorder(productId, dto);
  }
}
