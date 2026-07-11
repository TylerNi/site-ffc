import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminBrandsService } from './admin-brands.service';
import { AdminBrandDto, CreateBrandDto, UpdateBrandDto } from './dto/admin-catalog.dto';

/** Marques (tâche 10) : CRUD simple, pas de suppression dure (isActive). */
@AdminGuarded()
@Controller('admin/brands')
export class AdminBrandsController {
  constructor(private readonly brands: AdminBrandsService) {}

  @Get()
  @RequirePermissions('products.read')
  @ApiOperation({ summary: 'Liste des marques', operationId: 'adminListBrands' })
  @ApiOkResponse({ type: [AdminBrandDto] })
  list(): Promise<AdminBrandDto[]> {
    return this.brands.list();
  }

  @Post()
  @RequirePermissions('products.write')
  @ApiOperation({ summary: 'Crée une marque', operationId: 'adminCreateBrand' })
  @ApiOkResponse({ type: AdminBrandDto })
  create(@Body() dto: CreateBrandDto): Promise<AdminBrandDto> {
    return this.brands.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('products.write')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Modifie une marque', operationId: 'adminUpdateBrand' })
  @ApiOkResponse({ type: AdminBrandDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
  ): Promise<AdminBrandDto> {
    return this.brands.update(id, dto);
  }
}
