import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminCategoriesService } from './admin-categories.service';
import {
  AdminCategoryNodeDto,
  AdminCategoryTreeDto,
  CreateCategoryDto,
  MoveCategoryDto,
  UpdateCategoryDto,
} from './dto/admin-catalog.dto';

/** Catégories (tâche 10) : arborescence, CRUD, déplacement (garde anti-cycle). */
@AdminGuarded()
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categories: AdminCategoriesService) {}

  @Get()
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Arbre complet des catégories (actives et inactives)',
    operationId: 'adminCategoryTree',
  })
  @ApiOkResponse({ type: AdminCategoryTreeDto })
  tree(): Promise<AdminCategoryTreeDto> {
    return this.categories.tree();
  }

  @Post()
  @RequirePermissions('products.write')
  @ApiOperation({ summary: 'Crée une catégorie', operationId: 'adminCreateCategory' })
  @ApiOkResponse({ type: AdminCategoryNodeDto })
  create(@Body() dto: CreateCategoryDto): Promise<AdminCategoryNodeDto> {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Modifie traductions/statut/ordre', operationId: 'adminUpdateCategory' })
  @ApiOkResponse({ type: AdminCategoryNodeDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<AdminCategoryNodeDto> {
    return this.categories.update(id, dto);
  }

  @Patch(':id/move')
  @RequirePermissions('products.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Déplace la catégorie sous un nouveau parent',
    operationId: 'adminMoveCategory',
  })
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveCategoryDto): Promise<void> {
    return this.categories.move(id, dto);
  }
}
