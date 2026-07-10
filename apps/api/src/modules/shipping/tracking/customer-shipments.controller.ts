import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators';
import { CustomerShipmentsService } from './customer-shipments.service';
import { ListMyShipmentsQueryDto, MyShipmentsPageDto } from './dto/customer-shipments.dto';

/**
 * « Mes colis » côté client (tâche 14). Bearer OBLIGATOIRE (aucun `@Public`) :
 * le JwtAuthGuard global exige un compte, et le service ne renvoie jamais
 * que les colis des commandes de CE compte. Servira aussi le mobile (tâche 19).
 */
@ApiTags('mes-colis')
@ApiBearerAuth()
@Controller('me/shipments')
export class CustomerShipmentsController {
  constructor(private readonly shipments: CustomerShipmentsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Mes colis (actifs et historique), chronologie normalisée incluse',
    operationId: 'listMyShipments',
  })
  @ApiOkResponse({ type: MyShipmentsPageDto })
  list(
    @CurrentUser() user: User,
    @Query() query: ListMyShipmentsQueryDto,
  ): Promise<MyShipmentsPageDto> {
    return this.shipments.list(user, query.limit ?? 20, query.cursor);
  }
}
