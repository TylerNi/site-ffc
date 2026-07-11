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
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators';
import { AdminGuarded } from './admin-guarded.decorator';
import { RequirePermissions } from './admin-authz';
import { AdminInventoryService } from './admin-inventory.service';
import {
  AdjustInventoryDto,
  AdminInventoryItemDto,
  AdminInventoryMovementPageDto,
  AdminInventoryMovementQueryDto,
  AdminInventoryPageDto,
  AdminInventoryQueryDto,
  SetThresholdDto,
} from './dto/admin-inventory.dto';

/**
 * Inventaire (tâche 10) : niveaux, ajustements tracés (motif obligatoire),
 * seuils d'alerte, historique par variante.
 */
@AdminGuarded()
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory: AdminInventoryService) {}

  @Get()
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Niveaux de stock par variante', operationId: 'adminListInventory' })
  @ApiOkResponse({ type: AdminInventoryPageDto })
  list(@Query() query: AdminInventoryQueryDto): Promise<AdminInventoryPageDto> {
    return this.inventory.list(query);
  }

  @Get(':variantId/movements')
  @RequirePermissions('inventory.read')
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({
    summary: 'Historique des mouvements d’une variante',
    operationId: 'adminInventoryMovements',
  })
  @ApiOkResponse({ type: AdminInventoryMovementPageDto })
  movements(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Query() query: AdminInventoryMovementQueryDto,
  ): Promise<AdminInventoryMovementPageDto> {
    return this.inventory.movements(variantId, query);
  }

  @Patch(':variantId/threshold')
  @RequirePermissions('inventory.write')
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({
    summary: 'Fixe le seuil d’alerte de stock bas',
    operationId: 'adminSetInventoryThreshold',
  })
  @ApiOkResponse({ type: AdminInventoryItemDto })
  setThreshold(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: SetThresholdDto,
  ): Promise<AdminInventoryItemDto> {
    return this.inventory.setThreshold(variantId, dto);
  }

  @Post(':variantId/adjustments')
  @RequirePermissions('inventory.write')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({
    summary: 'Ajuste le stock (motif obligatoire) — crée un mouvement tracé',
    operationId: 'adminAdjustInventory',
  })
  @ApiOkResponse({ type: AdminInventoryItemDto })
  adjust(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: AdjustInventoryDto,
    @CurrentUser() actor: User,
  ): Promise<AdminInventoryItemDto> {
    return this.inventory.adjust(variantId, actor, dto);
  }
}
