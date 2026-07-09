import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { Public } from '../../auth/decorators';
import { sendPdf } from '../customer/customer-orders.controller';
import { InvoiceDownloadTokenService } from './invoice-download-token';
import { InvoiceService } from './invoice.service';

/**
 * Téléchargement de facture par LIEN SIGNÉ (tâche 12) — c'est le lien inclus
 * dans les courriels de commande. Fonctionne sans session (invités inclus)
 * mais reste inattaquable : le jeton HMAC vise UNE facture précise et expire.
 * Le bucket S3 demeure privé — les octets transitent par l'API.
 */
@ApiTags('factures')
@Public()
@Controller('invoices')
export class InvoiceDownloadController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly tokens: InvoiceDownloadTokenService,
  ) {}

  @Get(':id/download')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Télécharger une facture via un lien signé (courriel)',
    operationId: 'downloadInvoiceByToken',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const invoiceId = token ? this.tokens.verify(token) : null;
    if (!invoiceId || invoiceId !== id) {
      throw new UnauthorizedException('Lien de facture invalide ou expiré.');
    }
    const pdf = await this.invoices.fetchPdf(id);
    if (!pdf) {
      throw new UnauthorizedException('Facture indisponible.');
    }
    sendPdf(res, pdf.number, pdf.body);
  }
}
