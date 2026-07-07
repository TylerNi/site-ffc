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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type User } from '@prisma/client';
import { type Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { CookieService } from '../auth/cookie.service';
import { CurrentClaims, CurrentUser, Public, Roles } from '../auth/decorators';
import { MessageResponseDto } from '../auth/dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from '../auth/request-context';
import { type AccessTokenClaims } from '../auth/token.service';
import { AuditService } from '../audit/audit.service';
import {
  AdminLoginChallengeDto,
  AdminLoginDto,
  AdminMfaLoginDto,
  AdminProfileDto,
  AdminSessionDto,
  StepUpDto,
  StepUpResponseDto,
} from './dto/admin.dto';
import { PermissionsGuard } from './guards/permissions.guard';
import { PermissionService } from './permission.service';
import { StepUpService } from './step-up.service';

/** 10 tentatives / 15 min / IP — endpoints sensibles à la force brute. */
const STRICT_THROTTLE = { default: { limit: 10, ttl: 15 * 60_000 } };

/**
 * Sessions admin volontairement plus courtes que côté client (30 j) : le
 * cookie de refresh expire en 8 h. Combiné à la déconnexion sur inactivité
 * côté interface, la session admin reste brève.
 */
const ADMIN_REFRESH_COOKIE_MAX_AGE_MS = 8 * 3600_000;

/**
 * Authentification de l'administration (tâche 09) — parcours DÉDIÉ, distinct
 * du login client : courriel + mot de passe + TOTP obligatoire, refus si le
 * compte n'a pas de MFA active (impossible d'ouvrir une session admin sans
 * MFA), et ré-authentification « step-up » pour les actions sensibles.
 */
@ApiTags('admin')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connexion admin — étape 1 (courriel + mot de passe)',
    description:
      'Exige un rôle du personnel ET une MFA active. Renvoie un challengeToken à présenter à /admin/auth/login/mfa. Un compte sans MFA reçoit 403.',
    operationId: 'adminLogin',
  })
  @ApiOkResponse({ type: AdminLoginChallengeDto })
  async login(
    @Body() dto: AdminLoginDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminLoginChallengeDto> {
    return this.auth.adminLogin({ email: dto.email, password: dto.password }, requestContext(req));
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connexion admin — étape 2 (code TOTP obligatoire)',
    operationId: 'adminLoginMfa',
  })
  @ApiOkResponse({ type: AdminSessionDto })
  async loginMfa(
    @Body() dto: AdminMfaLoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSessionDto> {
    const { user, tokens } = await this.auth.completeAdminMfaLogin(
      dto.challengeToken,
      dto.code,
      requestContext(req),
    );
    this.cookies.setRefreshCookie(res, tokens.refreshToken, ADMIN_REFRESH_COOKIE_MAX_AGE_MS);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: tokens.expiresIn,
      profile: await this.buildProfile(user),
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Déconnexion admin (révoque la session)', operationId: 'adminLogout' })
  @ApiOkResponse({ type: MessageResponseDto })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageResponseDto> {
    const raw = this.cookies.refreshTokenFrom(req, undefined);
    await this.auth.logout(raw, requestContext(req));
    this.cookies.clearRefreshCookie(res);
    return { message: 'Déconnecté.' };
  }

  @Get('me')
  @Roles('STAFF', 'ADMIN')
  @UseGuards(PermissionsGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Profil admin courant (rôles + permissions effectives)',
    operationId: 'adminMe',
  })
  @ApiOkResponse({ type: AdminProfileDto })
  async me(@CurrentUser() user: User): Promise<AdminProfileDto> {
    return this.buildProfile(user);
  }

  @Post('step-up')
  @Roles('STAFF', 'ADMIN')
  @UseGuards(PermissionsGuard)
  @Throttle(STRICT_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ré-authentification « step-up » (code TOTP) pour actions sensibles',
    description:
      'Retourne un jeton court à joindre en en-tête X-Step-Up-Token aux actions sensibles (remboursements, rôles, exports).',
    operationId: 'adminStepUp',
  })
  @ApiOkResponse({ type: StepUpResponseDto })
  async requestStepUp(
    @Body() dto: StepUpDto,
    @CurrentUser() user: User,
    @CurrentClaims() claims: AccessTokenClaims,
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpResponseDto> {
    const ctx = requestContext(req);
    const valid = await this.auth.verifyMfaForStepUp(user, dto.code, ctx);
    if (!valid) {
      await this.audit.log({
        action: 'admin.auth.step_up.failed',
        actorId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
        ...ctx,
      });
      throw new UnauthorizedException('Code invalide.');
    }
    const issued = await this.stepUp.issue(user.id, claims.sid);
    await this.audit.log({
      action: 'admin.auth.step_up',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ...ctx,
    });
    return { stepUpToken: issued.token, expiresIn: issued.expiresIn };
  }

  private async buildProfile(user: User): Promise<AdminProfileDto> {
    const [roles, permissions] = await Promise.all([
      this.permissions.rolesOf(user.id),
      this.permissions.effectivePermissions(user.id),
    ]);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles,
      permissions: [...permissions].sort(),
      mfaEnabled: user.mfaEnabled,
    };
  }
}
