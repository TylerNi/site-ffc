import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type User } from '@prisma/client';
import { IsString, MaxLength } from 'class-validator';
import { type Response } from 'express';
import { AccountService } from './account.service';
import { CookieService } from '../auth/cookie.service';
import { CurrentUser } from '../auth/decorators';
import { MessageResponseDto } from '../auth/dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from '../auth/request-context';

class DeletionConfirmDto {
  @ApiProperty({ description: 'Jeton reçu par courriel (valide 30 minutes)' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

const MAIL_THROTTLE = { default: { limit: 5, ttl: 15 * 60_000 } };

/** Droits Loi 25 : export des renseignements personnels et effacement. */
@ApiTags('account')
@ApiBearerAuth()
@Controller('me')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly cookies: CookieService,
  ) {}

  @Get('export')
  @Throttle(MAIL_THROTTLE)
  @ApiOperation({
    summary: 'Export JSON des renseignements personnels (Loi 25)',
    operationId: 'exportMyData',
  })
  @ApiOkResponse({
    description: 'Document JSON — profil, adresses, commandes, équipements, avis, préférences…',
    schema: { type: 'object', additionalProperties: true },
  })
  async export(
    @CurrentUser() user: User,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ffc-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return this.account.exportData(user, requestContext(req));
  }

  @Post('deletion-request')
  @Throttle(MAIL_THROTTLE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Demande la suppression du compte (Loi 25)',
    description:
      'Confirmation forte : session valide + jeton envoyé par courriel. Rien n’est supprimé avant la confirmation.',
    operationId: 'requestAccountDeletion',
  })
  @ApiAcceptedResponse({ type: MessageResponseDto })
  async requestDeletion(
    @CurrentUser() user: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.account.requestDeletion(user, requestContext(req));
  }

  @Post('deletion-confirm')
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirme la suppression : anonymisation immédiate et déconnexion générale',
    operationId: 'confirmAccountDeletion',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async confirmDeletion(
    @Body() dto: DeletionConfirmDto,
    @CurrentUser() user: User,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageResponseDto> {
    const result = await this.account.confirmDeletion(user, dto.token, requestContext(req));
    this.cookies.clearRefreshCookie(res);
    return result;
  }
}
