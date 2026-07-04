import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { type Env, parseClientIds } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthMfaController } from './auth-mfa.controller';
import { AuthService } from './auth.service';
import { AuthSessionsController } from './auth-sessions.controller';
import { AuthSocialController } from './auth-social.controller';
import { CookieService } from './cookie.service';
import { GuestCartController } from './guest.controller';
import { GuestCartService } from './guest-cart.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LockoutService } from './lockout.service';
import { MfaService } from './mfa.service';
import { OneTimeTokenService } from './one-time-token.service';
import { RolesGuard } from './guards/roles.guard';
import { GlobalThrottlerGuard } from './guards/throttler.guard';
import { buildProductionVerifiers, OIDC_VERIFIERS } from './social/oidc-verifier';
import { SocialAuthService } from './social/social-auth.service';
import { TokenService } from './token.service';

/**
 * Authentification et comptes (tâche 05).
 *
 * Guards GLOBAUX, dans l'ordre d'exécution :
 *   1. ThrottlerGuard — rate limiting par IP (défaut 120 req/min, resserré
 *      par @Throttle sur login/register/reset…). En mémoire par instance;
 *      le verrouillage progressif PAR COMPTE (LockoutService, en base)
 *      reste la défense de fond multi-instances.
 *   2. JwtAuthGuard — Bearer JWT exigé partout sauf @Public().
 *   3. RolesGuard — @Roles(...) + MFA imposée sur les rôles du personnel.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { issuer: 'ffc-api', audience: 'ffc' },
        verifyOptions: { issuer: 'ffc-api', audience: 'ffc' },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      errorMessage: 'Trop de tentatives. Réessayez plus tard.',
    }),
  ],
  controllers: [
    AuthController,
    AuthMfaController,
    AuthSessionsController,
    AuthSocialController,
    GuestCartController,
  ],
  providers: [
    AuthService,
    TokenService,
    OneTimeTokenService,
    LockoutService,
    GuestCartService,
    MfaService,
    SocialAuthService,
    CookieService,
    {
      provide: OIDC_VERIFIERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildProductionVerifiers({
          googleClientIds: parseClientIds(config.get('GOOGLE_CLIENT_IDS', { infer: true })),
          appleClientIds: parseClientIds(config.get('APPLE_CLIENT_IDS', { infer: true })),
        }),
    },
    { provide: APP_GUARD, useClass: GlobalThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService, OneTimeTokenService, CookieService, GuestCartService],
})
export class AuthModule {}
