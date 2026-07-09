import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { type Response } from 'express';
import { CurrentUser } from '../../auth/decorators';
import { CustomerOrdersService } from './customer-orders.service';
import {
  CancelOrderResponseDto,
  ListMyOrdersQueryDto,
  MyOrderDetailDto,
  MyOrdersPageDto,
} from './dto/customer-orders.dto';

/**
 * « Mes commandes » côté client (tâche 12). Bearer OBLIGATOIRE (aucun
 * `@Public`/`@OptionalAuth`) : le JwtAuthGuard global exige un compte, et le
 * service ne renvoie jamais que les commandes de CE compte.
 */
@ApiTags('mes-commandes')
@ApiBearerAuth()
@Controller('me/orders')
export class CustomerOrdersController {
  constructor(private readonly orders: CustomerOrdersService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Liste paginée de mes commandes', operationId: 'listMyOrders' })
  @ApiOkResponse({ type: MyOrdersPageDto })
  list(@CurrentUser() user: User, @Query() query: ListMyOrdersQueryDto): Promise<MyOrdersPageDto> {
    return this.orders.list(user, query.limit ?? 20, query.cursor);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Détail d’une commande (articles, taxes, adresse, chronologie)',
    operationId: 'getMyOrder',
  })
  @ApiOkResponse({ type: MyOrderDetailDto })
  detail(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MyOrderDetailDto> {
    return this.orders.detail(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Annuler ma commande (avant expédition) — remboursement + restock',
    description:
      'Permise tant que la commande n’est pas poussée à l’expédition. Déclenche un remboursement Stripe intégral, la remise en inventaire, une note de crédit et un courriel d’annulation.',
    operationId: 'cancelMyOrder',
  })
  @ApiOkResponse({ type: CancelOrderResponseDto })
  cancel(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CancelOrderResponseDto> {
    return this.orders.cancel(user, id);
  }

  @Get(':id/invoice')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Télécharger la facture de ma commande (PDF)',
    operationId: 'downloadMyInvoice',
  })
  async invoice(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { number, body } = await this.orders.invoicePdf(user, id);
    sendPdf(res, number, body);
  }
}

/** Écrit un PDF de facture en pièce jointe (partagé avec le lien signé). */
export function sendPdf(res: Response, invoiceNumber: string, body: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(body);
}
