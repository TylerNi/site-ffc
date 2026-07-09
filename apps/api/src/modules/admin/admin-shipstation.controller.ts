import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import {
  type ShipstationSyncListItem,
  ShipstationSyncService,
} from '../shipping/shipstation/shipstation-sync.service';
import { CurrentUser } from '../auth/decorators';
import { AdminGuarded } from './admin-guarded.decorator';
import { AuditManual, RequirePermissions } from './admin-authz';
import {
  ShipstationSyncDto,
  ShipstationSyncPageDto,
  ShipstationSyncQueryDto,
} from './dto/shipstation.dto';

const DEFAULT_LIMIT = 25;

/**
 * Vue de RESYNCHRONISATION ShipStation (tâche 13).
 *
 * L'écran complet arrive à la tâche 22 ; ici, l'API et l'écran minimal :
 * la liste des commandes en échec de synchronisation, leur cause, et
 * l'action « repousser » qui rejoue l'opération (création ou annulation).
 *
 * Le contrôleur vit dans le module d'administration (gardes RBAC, MFA,
 * intercepteur d'audit) et consomme le service d'expédition — le sens des
 * dépendances reste admin → expédition → commandes.
 */
@AdminGuarded()
@Controller('admin/shipstation')
export class AdminShipstationController {
  constructor(private readonly sync: ShipstationSyncService) {}

  @Get()
  @RequirePermissions('shipments.read')
  @ApiOperation({
    summary: 'File de synchronisation ShipStation (échecs par défaut)',
    operationId: 'adminListShipstationSyncs',
  })
  @ApiOkResponse({ type: ShipstationSyncPageDto })
  async list(@Query() query: ShipstationSyncQueryDto): Promise<ShipstationSyncPageDto> {
    const [page, counts] = await Promise.all([
      this.sync.list({
        status: query.status,
        limit: query.limit ?? DEFAULT_LIMIT,
        cursor: query.cursor,
      }),
      this.sync.counts(),
    ]);
    return {
      items: page.items.map(toDto),
      nextCursor: page.nextCursor,
      counts,
      configured: this.sync.isConfigured(),
    };
  }

  /**
   * « Repousser » : réarme la ligne et la traite immédiatement. Pas de
   * step-up — l'action est réparatrice, jamais destructrice, et l'opération
   * poussée reste idempotente côté ShipStation.
   */
  @Post(':orderId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shipments.write')
  @AuditManual() // ShipstationSyncService consigne « shipstation.retry » avec son contexte
  @ApiOperation({
    summary: 'Repousse une commande vers ShipStation',
    operationId: 'adminRetryShipstationSync',
  })
  @ApiOkResponse({ type: ShipstationSyncDto })
  async retry(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() actor: User,
  ): Promise<ShipstationSyncDto> {
    return toDto(await this.sync.retry(orderId, { type: 'admin', userId: actor.id }));
  }
}

function toDto(item: ShipstationSyncListItem): ShipstationSyncDto {
  return {
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    orderStatus: item.orderStatus,
    totalCents: item.totalCents,
    currency: item.currency,
    paidAt: item.paidAt?.toISOString() ?? null,
    status: item.status,
    operation: item.operation,
    attempts: item.attempts,
    lastError: item.lastError,
    lastAttemptAt: item.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: item.nextAttemptAt?.toISOString() ?? null,
    shipstationOrderId: item.shipstationOrderId,
    updatedAt: item.updatedAt.toISOString(),
  };
}
