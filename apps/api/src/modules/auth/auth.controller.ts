import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type Response } from 'express';
import { AuthService, type LoginResult } from './auth.service';
import { CookieService } from './cookie.service';
import { CurrentClaims, CurrentUser, Public } from './decorators';
import {
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  LoginResponseDto,
  MessageResponseDto,
  MfaLoginDto,
  RefreshDto,
  RefreshResponseDto,
  RegisterDto,
  ResetPasswordDto,
  toUserProfile,
  UserProfileDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from './request-context';
import { type AccessTokenClaims, TokenService } from './token.service';
import { type User } from '@prisma/client';

/** 10 requêtes / 15 min / IP — endpoints sensibles à la force brute. */
const STRICT_THROTTLE = { default: { limit: 10, ttl: 15 * 60_000 } };
/** 5 requêtes / 15 min / IP — endpoints qui envoient un courriel. */
const MAIL_THROTTLE = { default: { limit: 5, ttl: 15 * 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly cookies: CookieService,
  ) {}

  /* ---------------------------- Inscription --------------------------- */

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('register')
  @ApiOperation({
    summary: 'Inscription par courriel',
    description:
      'Réponse identique que l’adresse soit libre ou non (anti-énumération). Envoie un courriel de vérification; aucune session n’est ouverte.',
    operationId: 'register',
  })
  @ApiCreatedResponse({ type: MessageResponseDto })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.register(
      {
        email: dto.email,
        password: dto.password,
        firstName: dto.firstName,
        lastName: dto.lastName,
        locale: dto.locale ?? 'fr',
        guestCartToken: dto.guestCartToken,
      },
      requestContext(req),
    );
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirme une adresse courriel', operationId: 'verifyEmail' })
  @ApiOkResponse({ type: MessageResponseDto })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.verifyEmail(dto.token, requestContext(req));
  }

  @Public()
  @Throttle(MAIL_THROTTLE)
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Renvoie le courriel de vérification',
    description: '202 systématique, que le compte existe ou non.',
    operationId: 'resendVerification',
  })
  @ApiAcceptedResponse({ type: MessageResponseDto })
  async resendVerification(
    @Body() dto: EmailOnlyDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.resendVerification(dto.email, requestContext(req));
  }

  /* ------------------------------ Connexion --------------------------- */

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connexion par courriel et mot de passe',
    description:
      'Si la MFA est active : renvoie mfaRequired=true et un challengeToken à présenter à POST /auth/login/mfa. Sinon : jetons de session (le refresh est aussi posé en cookie httpOnly).',
    operationId: 'login',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const result = await this.auth.login(
      { email: dto.email, password: dto.password, guestCartToken: dto.guestCartToken },
      requestContext(req),
    );
    return this.loginResponse(result, res);
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Second facteur de la connexion (code TOTP ou code de secours)',
    operationId: 'loginMfa',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async loginMfa(
    @Body() dto: MfaLoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { user, tokens } = await this.auth.completeMfaLogin(
      dto.challengeToken,
      dto.code,
      dto.guestCartToken,
      requestContext(req),
    );
    return this.loginResponse({ mfaRequired: false, user, tokens }, res);
  }

  private loginResponse(result: LoginResult, res: Response): LoginResponseDto {
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

  /* ----------------------------- Rafraîchir --------------------------- */

  @Public()
  @Throttle({ default: { limit: 60, ttl: 15 * 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotation du refresh token',
    description:
      'Jeton lu dans le corps (mobile) ou le cookie httpOnly (web). Chaque jeton ne sert qu’UNE fois; une réutilisation révoque la session entière.',
    operationId: 'refreshTokens',
  })
  @ApiOkResponse({ type: RefreshResponseDto })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponseDto> {
    const raw = this.cookies.refreshTokenFrom(req, dto.refreshToken);
    // Même erreur neutre que pour un jeton invalide.
    if (!raw) throw new UnauthorizedException('Session invalide ou expirée.');
    const rotated = await this.tokens.rotate(raw, requestContext(req));
    this.cookies.setRefreshCookie(res, rotated.refreshToken);
    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      tokenType: 'Bearer',
      expiresIn: rotated.expiresIn,
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Déconnexion (révoque la session du refresh token présenté)',
    operationId: 'logout',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageResponseDto> {
    const raw = this.cookies.refreshTokenFrom(req, dto.refreshToken);
    await this.auth.logout(raw, requestContext(req));
    this.cookies.clearRefreshCookie(res);
    return { message: 'Déconnecté.' };
  }

  /* --------------------------- Mot de passe --------------------------- */

  @Public()
  @Throttle(MAIL_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Demande de réinitialisation de mot de passe',
    description: '202 systématique, que le compte existe ou non.',
    operationId: 'forgotPassword',
  })
  @ApiAcceptedResponse({ type: MessageResponseDto })
  async forgotPassword(
    @Body() dto: EmailOnlyDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.forgotPassword(dto.email, requestContext(req));
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Réinitialise le mot de passe (jeton à usage unique)',
    description: 'Révoque TOUTES les sessions du compte.',
    operationId: 'resetPassword',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.resetPassword(dto.token, dto.newPassword, requestContext(req));
  }

  @Throttle(STRICT_THROTTLE)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change le mot de passe (connecté) — révoque les autres sessions',
    operationId: 'changePassword',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: User,
    @CurrentClaims() claims: AccessTokenClaims,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageResponseDto> {
    return this.auth.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
      claims.sid,
      requestContext(req),
    );
  }

  /* -------------------------------- Profil ---------------------------- */

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Profil du compte connecté', operationId: 'getMe' })
  @ApiOkResponse({ type: UserProfileDto })
  me(@CurrentUser() user: User): UserProfileDto {
    return toUserProfile(user);
  }
}
