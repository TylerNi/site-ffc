import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type Response } from 'express';
import { CookieService } from './cookie.service';
import { Public } from './decorators';
import { LoginResponseDto, SocialLoginDto, toUserProfile } from './dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from './request-context';
import { type LoginResult } from './auth.service';
import { SocialAuthService } from './social/social-auth.service';
import { type SocialProvider } from './social/oidc-verifier';

const STRICT_THROTTLE = { default: { limit: 10, ttl: 15 * 60_000 } };

/**
 * Connexions sociales OIDC. Rappel de conformité : Apple Sign-In est
 * offert partout où Google l'est (obligatoire sur iOS — App Store 4.8).
 */
@ApiTags('auth')
@Controller('auth/social')
export class AuthSocialController {
  constructor(
    private readonly social: SocialAuthService,
    private readonly cookies: CookieService,
  ) {}

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connexion / inscription via un ID token Google',
    description:
      'Le client obtient l’ID token via Google Sign-In puis le présente ici. Compte MFA → défi TOTP comme au login classique.',
    operationId: 'loginWithGoogle',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async google(
    @Body() dto: SocialLoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    return this.handle('google', dto, req, res);
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('apple')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connexion / inscription via un ID token Apple',
    operationId: 'loginWithApple',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async apple(
    @Body() dto: SocialLoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    return this.handle('apple', dto, req, res);
  }

  private async handle(
    provider: SocialProvider,
    dto: SocialLoginDto,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<LoginResponseDto> {
    const result: LoginResult = await this.social.login(
      provider,
      {
        idToken: dto.idToken,
        guestCartToken: dto.guestCartToken,
        locale: dto.locale ?? 'fr',
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
      requestContext(req),
    );
    if (result.mfaRequired) {
      return { mfaRequired: true, challengeToken: result.challengeToken };
    }
    this.cookies.setRefreshCookie(res, result.tokens.refreshToken);
    return {
      mfaRequired: false,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: result.tokens.expiresIn,
      user: toUserProfile(result.user),
    };
  }
}
