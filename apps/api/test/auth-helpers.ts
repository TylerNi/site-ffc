import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type User } from '@prisma/client';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap-app';
import { PrismaService } from '../src/database';
import { MailService, type OutboxEntry } from '../src/modules/mail/mail.service';
import { hashPassword } from '../src/modules/auth/password';
import {
  OIDC_VERIFIERS,
  type OidcIdentity,
  type OidcVerifier,
  type SocialProvider,
} from '../src/modules/auth/social/oidc-verifier';
import { getTestDatabaseUrl } from './helpers';

/**
 * Fabrique d'application Nest COMPLÈTE pour les tests e2e d'authentification :
 * vraie AppModule, vrais guards globaux, vraie base ffc_test — seuls les
 * vérificateurs OIDC distants sont substitués (pas d'appel réseau à
 * Google/Apple) et le courriel part dans l'outbox mémoire (MAIL_DRIVER=log).
 */

export interface AuthTestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: MailService;
  http: () => request.Agent;
  close: () => Promise<void>;
}

export interface CreateTestAppOptions {
  /** true = rate limiting par IP ACTIF (test de throttling dédié). */
  throttleEnabled?: boolean;
  /** Vérificateurs OIDC injectés (FakeOidcVerifier en général). */
  verifiers?: OidcVerifier[];
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<AuthTestContext> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = getTestDatabaseUrl();
  process.env.MAIL_DRIVER = 'log';
  process.env.AUTH_THROTTLE_DISABLED = options.throttleEnabled ? '0' : '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OIDC_VERIFIERS)
    .useValue(options.verifiers ?? [])
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    mail: app.get(MailService),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

/* ------------------------------ Courriels ------------------------------ */

/** Dernier courriel envoyé à `to` (optionnellement d'un gabarit précis). */
export function lastMail(
  ctx: AuthTestContext,
  to: string,
  templateKey?: OutboxEntry['templateKey'],
): OutboxEntry | undefined {
  return [...ctx.mail.outbox]
    .reverse()
    .find((entry) => entry.to === to && (!templateKey || entry.templateKey === templateKey));
}

/** Extrait le jeton `?token=…` d'une variable-lien d'un courriel capturé. */
export function tokenFromMail(entry: OutboxEntry | undefined, urlVariable: string): string {
  if (!entry) throw new Error('Aucun courriel capturé — outbox vide pour ce destinataire.');
  const url = entry.variables[urlVariable];
  if (!url) throw new Error(`Variable « ${urlVariable} » absente du courriel ${entry.templateKey}`);
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error(`Pas de paramètre token dans ${url}`);
  return token;
}

/* ------------------------------- Comptes ------------------------------- */

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@test.ffc.local`;
}

export const TEST_PASSWORD = 'Chauffage!2026-filtres';

/** Inscription par l'API + vérification du courriel via le jeton capturé. */
export async function registerAndVerify(
  ctx: AuthTestContext,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<void> {
  await ctx.http().post('/v1/auth/register').send({ email, password }).expect(201);
  const token = tokenFromMail(lastMail(ctx, email, 'email_verification'), 'verifyUrl');
  await ctx.http().post('/v1/auth/verify-email').send({ token }).expect(200);
}

export interface LoginBody {
  mfaRequired: boolean;
  challengeToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: { id: string; email: string };
}

export async function login(
  ctx: AuthTestContext,
  email: string,
  password: string = TEST_PASSWORD,
  extra: Record<string, unknown> = {},
): Promise<LoginBody> {
  const response = await ctx
    .http()
    .post('/v1/auth/login')
    .send({ email, password, ...extra })
    .expect(200);
  return response.body as LoginBody;
}

export function bearer(accessToken: string | undefined): string {
  if (!accessToken) throw new Error('Access token manquant');
  return `Bearer ${accessToken}`;
}

/** Compte créé directement en base (admin de test, comptes spéciaux…). */
export async function createUserInDb(
  ctx: AuthTestContext,
  overrides: Partial<{
    email: string;
    password: string;
    role: User['role'];
    emailVerified: boolean;
  }> = {},
): Promise<{ user: User; email: string; password: string }> {
  const email = overrides.email ?? uniqueEmail('direct');
  const password = overrides.password ?? TEST_PASSWORD;
  const user = await ctx.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      role: overrides.role ?? 'CUSTOMER',
      emailVerifiedAt: (overrides.emailVerified ?? true) ? new Date() : null,
    },
  });
  return { user, email, password };
}

/* --------------------------------- TOTP -------------------------------- */

/** Code TOTP valide pour un secret d'enrôlement (mêmes paramètres que l'API). */
export function totpCode(secretBase32: string, stepOffset = 0): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: Date.now() + stepOffset * 30_000 });
}

/* --------------------------------- OIDC -------------------------------- */

/**
 * Vérificateur OIDC de test : l'« ID token » est un JSON en clair décrivant
 * l'identité à retourner — aucun réseau, aucune crypto.
 */
export class FakeOidcVerifier implements OidcVerifier {
  constructor(readonly provider: SocialProvider) {}

  async verify(idToken: string): Promise<OidcIdentity> {
    let parsed: Partial<OidcIdentity> & { fail?: boolean };
    try {
      parsed = JSON.parse(idToken) as Partial<OidcIdentity> & { fail?: boolean };
    } catch {
      throw new UnauthorizedException(`Jeton ${this.provider} invalide.`);
    }
    if (parsed.fail || !parsed.subject) {
      throw new UnauthorizedException(`Jeton ${this.provider} invalide.`);
    }
    return {
      provider: this.provider,
      subject: parsed.subject,
      email: parsed.email ?? null,
      emailVerified: parsed.emailVerified ?? false,
      givenName: parsed.givenName ?? null,
      familyName: parsed.familyName ?? null,
    };
  }
}

/** Corps `idToken` compris par FakeOidcVerifier. */
export function fakeIdToken(identity: Partial<OidcIdentity> & { fail?: boolean }): string {
  return JSON.stringify(identity);
}
