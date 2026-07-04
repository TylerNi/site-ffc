import { Controller, Delete, Get, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { type User } from '@prisma/client';
import { type Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { CookieService } from './cookie.service';
import { CurrentClaims, CurrentUser } from './decorators';
import { RevokeSessionsResponseDto, SessionItemDto } from './dto/auth.dto';
import { type AuthenticatedRequest, requestContext } from './request-context';
import { type AccessTokenClaims, TokenService } from './token.service';

/**
 * Gestion multi-appareils des sessions (tâche 05) : une session = une
 * famille de refresh tokens; l'access token porte la sienne dans `sid`.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/sessions')
export class AuthSessionsController {
  constructor(
    private readonly tokens: TokenService,
    private readonly cookies: CookieService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des sessions actives du compte', operationId: 'listSessions' })
  @ApiOkResponse({ type: [SessionItemDto] })
  async list(
    @CurrentUser() user: User,
    @CurrentClaims() claims: AccessTokenClaims,
  ): Promise<SessionItemDto[]> {
    const sessions = await this.tokens.listSessions(user.id, claims.sid);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      ip: session.ip,
      userAgent: session.userAgent,
      current: session.current,
    }));
  }

  @Delete(':sessionId')
  @ApiOperation({
    summary: 'Révoque une session (déconnecte l’appareil visé)',
    operationId: 'revokeSession',
  })
  @ApiParam({ name: 'sessionId', format: 'uuid' })
  @ApiOkResponse({ type: RevokeSessionsResponseDto })
  async revokeOne(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: User,
    @CurrentClaims() claims: AccessTokenClaims,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevokeSessionsResponseDto> {
    // Un compte ne révoque que SES sessions : la famille doit lui appartenir.
    const sessions = await this.tokens.listSessions(user.id, claims.sid);
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) return { revokedSessions: 0 };

    const revoked = await this.tokens.revokeFamily(sessionId);
    if (target.current) this.cookies.clearRefreshCookie(res);
    await this.audit.log({
      action: 'auth.sessions.revoked',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'refresh_token_family',
      entityId: sessionId,
      metadata: { scope: 'single', current: target.current },
      ...requestContext(req),
    });
    return { revokedSessions: revoked > 0 ? 1 : 0 };
  }

  @Delete()
  @ApiOperation({
    summary: 'Révocation globale des sessions',
    description:
      'Par défaut, déconnecte tous les AUTRES appareils. Avec ?all=true, révoque aussi la session courante.',
    operationId: 'revokeAllSessions',
  })
  @ApiQuery({ name: 'all', required: false, type: Boolean })
  @ApiOkResponse({ type: RevokeSessionsResponseDto })
  async revokeAll(
    @CurrentUser() user: User,
    @CurrentClaims() claims: AccessTokenClaims,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('all') all?: string,
  ): Promise<RevokeSessionsResponseDto> {
    const includeCurrent = all === 'true';
    const beforeCount = (await this.tokens.listSessions(user.id, claims.sid)).length;
    await this.tokens.revokeAllForUser(user.id, includeCurrent ? undefined : claims.sid);
    const afterCount = (await this.tokens.listSessions(user.id, claims.sid)).length;
    if (includeCurrent) this.cookies.clearRefreshCookie(res);
    await this.audit.log({
      action: 'auth.sessions.revoked',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      metadata: { scope: includeCurrent ? 'all' : 'others' },
      ...requestContext(req),
    });
    return { revokedSessions: beforeCount - afterCount };
  }
}
