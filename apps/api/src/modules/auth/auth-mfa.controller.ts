import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type User } from '@prisma/client';
import { CurrentUser } from './decorators';
import {
  MessageResponseDto,
  MfaActivateResponseDto,
  MfaCodeDto,
  MfaEnrollResponseDto,
} from './dto/auth.dto';
import { MfaService } from './mfa.service';
import { type AuthenticatedRequest, requestContext } from './request-context';

const STRICT_THROTTLE = { default: { limit: 10, ttl: 15 * 60_000 } };

/**
 * MFA TOTP en libre-service (routes simplement authentifiées : un admin
 * SANS MFA doit pouvoir passer par ici pour l'activer — c'est la seule
 * porte vers les routes admin, verrouillées par RolesGuard).
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/mfa')
export class AuthMfaController {
  constructor(private readonly mfa: MfaService) {}

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({
    summary: 'Démarre l’enrôlement MFA (secret + QR otpauth)',
    description:
      'Le secret reste en attente tant qu’un premier code valide n’a pas été fourni à /auth/mfa/activate.',
    operationId: 'mfaEnroll',
  })
  @ApiOkResponse({ type: MfaEnrollResponseDto })
  async enroll(@CurrentUser() user: User): Promise<MfaEnrollResponseDto> {
    return this.mfa.enroll(user);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({
    summary: 'Active la MFA (premier code TOTP) et retourne les codes de secours',
    description: 'Les codes de secours ne sont montrés qu’UNE fois — à conserver hors ligne.',
    operationId: 'mfaActivate',
  })
  @ApiOkResponse({ type: MfaActivateResponseDto })
  async activate(
    @Body() dto: MfaCodeDto,
    @CurrentUser() user: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<MfaActivateResponseDto> {
    return this.mfa.activate(user, dto.code, requestContext(req));
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_THROTTLE)
  @ApiOperation({
    summary: 'Désactive la MFA (code TOTP ou code de secours exigé)',
    description: 'Refusé (403) pour les comptes STAFF/ADMIN : leur MFA est imposée par le serveur.',
    operationId: 'mfaDisable',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async disable(
    @Body() dto: MfaCodeDto,
    @CurrentUser() user: User,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    await this.mfa.disable(user, dto.code, requestContext(req));
    return { message: 'MFA désactivée.' };
  }
}
