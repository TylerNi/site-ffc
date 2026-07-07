import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { GuestCartService } from './guest-cart.service';
import { LockoutService } from './lockout.service';
import { MfaService } from './mfa.service';
import { ONE_TIME_TOKEN_TTL_MS, OneTimeTokenService } from './one-time-token.service';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './password';
import { type IssuedTokens, type RequestContext, TokenService } from './token.service';

const NEUTRAL_LOGIN_ERROR = 'Courriel ou mot de passe invalide.';

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  locale: Locale;
  guestCartToken?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  guestCartToken?: string;
}

/** Résultat d'un login : soit une session, soit un défi MFA à relever. */
export type LoginResult =
  | { mfaRequired: false; user: User; tokens: IssuedTokens }
  | { mfaRequired: true; challengeToken: string };

export interface CompleteLoginOptions {
  guestCartToken?: string;
  /** « password », « google », « apple » — pour l'audit. */
  method: string;
  mfaUsed?: boolean;
}

/**
 * Parcours courriel de l'authentification (tâche 05) : inscription,
 * vérification, connexion (avec défi MFA), réinitialisation et changement
 * de mot de passe.
 *
 * Anti-énumération : les réponses (statut, message, coût) sont identiques
 * que le compte existe ou non — hachage factice sur les comptes inconnus,
 * 202 systématique sur forgot/resend, 201 systématique à l'inscription.
 */
@Injectable()
export class AuthService {
  private readonly webUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly oneTimeTokens: OneTimeTokenService,
    private readonly lockout: LockoutService,
    private readonly guestCarts: GuestCartService,
    private readonly mfa: MfaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.webUrl = config.get('APP_WEB_URL', { infer: true }).replace(/\/$/, '');
  }

  /* ----------------------------- Inscription --------------------------- */

  /**
   * Réponse volontairement IDENTIQUE que le courriel soit libre ou déjà
   * pris (le hachage a lieu dans les deux cas pour un coût constant).
   * Aucune session n'est ouverte : le client se connecte ensuite.
   */
  async register(input: RegisterInput, ctx: RequestContext): Promise<{ message: string }> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: input.firstName?.trim() || null,
          lastName: input.lastName?.trim() || null,
          locale: input.locale,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Compte déjà existant : réponse neutre, tentative auditée.
        await this.audit.log({
          action: 'auth.register.duplicate',
          actorType: 'system',
          actorEmail: email,
          metadata: { email },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return this.registrationResponse();
      }
      throw error;
    }

    await this.sendVerificationEmail(user, ctx);
    await this.guestCarts.mergeIntoAccount(user.id, input.guestCartToken, ctx);
    await this.audit.log({
      action: 'auth.register',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.registrationResponse();
  }

  private registrationResponse(): { message: string } {
    return {
      message:
        'Si cette adresse est disponible, un courriel de vérification vient d’être envoyé. Vous pouvez maintenant vous connecter.',
    };
  }

  private async sendVerificationEmail(user: User, ctx: RequestContext): Promise<void> {
    const { raw } = await this.oneTimeTokens.issue(user.id, 'EMAIL_VERIFICATION', ctx);
    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'email_verification',
      variables: { ttl: user.locale === 'fr' ? '24 heures' : '24 hours' },
      secretVariables: {
        verifyUrl: `${this.webUrl}/${user.locale}/compte/verifier-courriel?token=${raw}`,
      },
    });
  }

  async verifyEmail(rawToken: string, ctx: RequestContext): Promise<{ message: string }> {
    const token = await this.oneTimeTokens.consume(rawToken, 'EMAIL_VERIFICATION');
    if (!token) throw new BadRequestException('Lien invalide ou expiré.');
    const user = await this.prisma.user.findUnique({ where: { id: token.userId } });
    if (!user || user.status !== 'ACTIVE') {
      throw new BadRequestException('Lien invalide ou expiré.');
    }
    if (!user.emailVerifiedAt) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    await this.audit.log({
      action: 'auth.email.verified',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Adresse courriel confirmée. Bienvenue!' };
  }

  /** 202 systématique — n'indique jamais si le compte existe. */
  async resendVerification(email: string, ctx: RequestContext): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (user && user.status === 'ACTIVE' && !user.emailVerifiedAt) {
      await this.sendVerificationEmail(user, ctx);
    }
    return {
      message: 'Si un compte non vérifié existe pour cette adresse, un courriel a été renvoyé.',
    };
  }

  /* ------------------------------ Connexion ---------------------------- */

  /**
   * Vérifie identifiant + mot de passe et renvoie l'utilisateur ACTIF, ou
   * lève l'erreur 401 neutre (anti-énumération, verrouillage, hachage
   * factice à coût constant). Tronc commun du login client ET du login admin.
   */
  private async assertPasswordCredentials(
    rawEmail: string,
    password: string,
    ctx: RequestContext,
  ): Promise<User> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
      // Coût constant : on vérifie quand même un hachage factice.
      await verifyAgainstDummyHash(password);
      await this.audit.log({
        action: 'auth.login.failed',
        actorType: 'system',
        actorEmail: email,
        metadata: { reason: user ? 'no_password' : 'unknown_account' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException(NEUTRAL_LOGIN_ERROR);
    }

    this.lockout.assertNotLocked(user);

    const passwordValid = await verifyPassword(user.passwordHash, password);
    if (!passwordValid) {
      await this.lockout.registerFailure(user, ctx, 'password');
      throw new UnauthorizedException(NEUTRAL_LOGIN_ERROR);
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.log({
        action: 'auth.login.blocked',
        actorType: 'system',
        actorId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
        metadata: { status: user.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException(NEUTRAL_LOGIN_ERROR);
    }

    return user;
  }

  async login(input: LoginInput, ctx: RequestContext): Promise<LoginResult> {
    const user = await this.assertPasswordCredentials(input.email, input.password, ctx);

    if (user.mfaEnabled) {
      return this.issueMfaChallenge(user, ctx);
    }

    const tokens = await this.completeLogin(user, ctx, {
      guestCartToken: input.guestCartToken,
      method: 'password',
    });
    return { mfaRequired: false, user, tokens };
  }

  /* ------------------------- Connexion admin (tâche 09) ------------------ */

  /**
   * Connexion à l'administration : mêmes vérifications que `login`, plus deux
   * exigences propres à l'admin —
   *   1. rôle du personnel (STAFF/ADMIN) — sinon 401 neutre (ne révèle pas
   *      qu'un compte client a visé l'admin);
   *   2. MFA active — sinon 403 explicite : impossible d'OUVRIR une session
   *      admin sans MFA (critère d'acceptation). L'enrôlement se fait par le
   *      parcours client (`/v1/auth/mfa/*`).
   * Renvoie toujours un défi MFA — le second facteur est obligatoire ici.
   */
  async adminLogin(input: LoginInput, ctx: RequestContext): Promise<{ challengeToken: string }> {
    const user = await this.assertPasswordCredentials(input.email, input.password, ctx);

    if (user.role !== 'ADMIN' && user.role !== 'STAFF') {
      await this.audit.log({
        action: 'admin.login.denied',
        actorType: 'system',
        actorId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
        metadata: { reason: 'not_staff' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException(NEUTRAL_LOGIN_ERROR);
    }

    if (!user.mfaEnabled) {
      await this.audit.log({
        action: 'admin.login.mfa_required',
        actorType: 'system',
        actorId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new ForbiddenException(
        'Double authentification obligatoire : activez la MFA sur votre compte (espace client) avant d’accéder à l’administration.',
      );
    }

    const challenge = await this.issueMfaChallenge(user, ctx);
    if (!challenge.mfaRequired) throw new UnauthorizedException(NEUTRAL_LOGIN_ERROR);
    return { challengeToken: challenge.challengeToken };
  }

  /**
   * Second facteur du login admin : réutilise `completeMfaLogin` puis
   * re-vérifie le rôle (défense en profondeur — le défi ne porte pas le rôle).
   */
  async completeAdminMfaLogin(
    challengeToken: string,
    code: string,
    ctx: RequestContext,
  ): Promise<{ user: User; tokens: IssuedTokens }> {
    const result = await this.completeMfaLogin(challengeToken, code, undefined, ctx);
    if (result.user.role !== 'ADMIN' && result.user.role !== 'STAFF') {
      await this.tokens.revokeFamily(result.tokens.familyId);
      throw new UnauthorizedException('Défi MFA invalide ou expiré.');
    }
    await this.audit.log({
      action: 'admin.login.success',
      actorId: result.user.id,
      actorEmail: result.user.email,
      entityType: 'user',
      entityId: result.user.id,
      metadata: { sessionFamilyId: result.tokens.familyId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return result;
  }

  /**
   * Vérifie un code TOTP/secours pour une ré-authentification « step-up »
   * (actions sensibles admin). Délègue à la MFA; ne délivre aucune session.
   */
  async verifyMfaForStepUp(user: User, code: string, ctx: RequestContext): Promise<boolean> {
    return this.mfa.verifyCode(user, code, ctx);
  }

  async issueMfaChallenge(user: User, ctx: RequestContext): Promise<LoginResult> {
    const { raw } = await this.oneTimeTokens.issue(user.id, 'MFA_CHALLENGE', ctx);
    await this.audit.log({
      action: 'auth.login.mfa_challenge',
      actorType: 'system',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { mfaRequired: true, challengeToken: raw };
  }

  /**
   * Second facteur du login. Le défi reste valide (5 min) tant qu'un code
   * correct n'est pas fourni; chaque code erroné compte dans le
   * verrouillage progressif du compte.
   */
  async completeMfaLogin(
    challengeToken: string,
    code: string,
    guestCartToken: string | undefined,
    ctx: RequestContext,
  ): Promise<{ user: User; tokens: IssuedTokens }> {
    const challenge = await this.oneTimeTokens.peek(challengeToken, 'MFA_CHALLENGE');
    if (!challenge) throw new UnauthorizedException('Défi MFA invalide ou expiré.');

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Défi MFA invalide ou expiré.');
    }
    this.lockout.assertNotLocked(user);

    const valid = await this.mfa.verifyCode(user, code, ctx);
    if (!valid) {
      await this.lockout.registerFailure(user, ctx, 'mfa');
      throw new UnauthorizedException('Code invalide.');
    }

    const consumed = await this.oneTimeTokens.consumeById(challenge.id);
    if (!consumed) throw new UnauthorizedException('Défi MFA invalide ou expiré.');

    const tokens = await this.completeLogin(user, ctx, {
      guestCartToken,
      method: 'password',
      mfaUsed: true,
    });
    return { user, tokens };
  }

  /**
   * Tronc commun de fin de connexion (mot de passe, MFA, social) :
   * session, fusion du panier invité, compteurs, notification
   * « nouvel appareil » et audit.
   */
  async completeLogin(
    user: User,
    ctx: RequestContext,
    options: CompleteLoginOptions,
  ): Promise<IssuedTokens> {
    const now = new Date();
    const firstLogin = user.lastLoginAt === null;
    const knownDevice = await this.tokens.isKnownDevice(user.id, ctx.userAgent, now);

    const tokens = await this.tokens.issueSession(user, ctx);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    await this.guestCarts.mergeIntoAccount(user.id, options.guestCartToken, ctx);

    if (!firstLogin && !knownDevice) {
      await this.mail.send({
        userId: user.id,
        to: user.email,
        locale: user.locale,
        templateKey: 'new_device_login',
        variables: {
          device: ctx.userAgent ?? (user.locale === 'fr' ? 'appareil inconnu' : 'unknown device'),
          ip: ctx.ip ?? '—',
          date: now.toISOString(),
        },
      });
    }

    await this.audit.log({
      action: 'auth.login.success',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      metadata: {
        method: options.method,
        mfaUsed: options.mfaUsed ?? false,
        sessionFamilyId: tokens.familyId,
        newDevice: !firstLogin && !knownDevice,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return tokens;
  }

  /* --------------------------- Déconnexion ----------------------------- */

  /** Idempotent : 200 même si le jeton est inconnu (déconnexion « au mieux »). */
  async logout(rawRefreshToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawRefreshToken) return;
    const token = await this.tokens.findFamilyByRawToken(rawRefreshToken);
    if (!token) return;
    await this.tokens.revokeFamily(token.familyId);
    await this.audit.log({
      action: 'auth.logout',
      actorId: token.userId,
      entityType: 'refresh_token_family',
      entityId: token.familyId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /* ------------------------ Mot de passe oublié ------------------------ */

  /** 202 systématique — n'indique jamais si le compte existe. */
  async forgotPassword(email: string, ctx: RequestContext): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (user && user.status === 'ACTIVE') {
      const { raw } = await this.oneTimeTokens.issue(user.id, 'PASSWORD_RESET', ctx);
      await this.mail.send({
        userId: user.id,
        to: user.email,
        locale: user.locale,
        templateKey: 'password_reset',
        variables: { ttl: user.locale === 'fr' ? '30 minutes' : '30 minutes' },
        secretVariables: {
          resetUrl: `${this.webUrl}/${user.locale}/compte/reinitialiser?token=${raw}`,
        },
      });
      await this.audit.log({
        action: 'auth.password.reset_requested',
        actorType: 'system',
        actorId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    return {
      message:
        'Si un compte existe pour cette adresse, un courriel de réinitialisation a été envoyé.',
    };
  }

  /**
   * Réinitialisation : jeton à usage unique, TOUTES les sessions sont
   * révoquées (un voleur de session ne survit pas au changement de mot de
   * passe), verrouillage remis à zéro.
   */
  async resetPassword(
    rawToken: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const token = await this.oneTimeTokens.consume(rawToken, 'PASSWORD_RESET');
    if (!token) throw new BadRequestException('Lien invalide ou expiré.');

    const user = await this.prisma.user.findUnique({ where: { id: token.userId } });
    if (!user || user.status !== 'ACTIVE') {
      throw new BadRequestException('Lien invalide ou expiré.');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        // Le lien de réinitialisation prouve le contrôle du courriel.
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });
    await this.tokens.revokeAllForUser(user.id);
    await this.oneTimeTokens.invalidateAll(user.id, 'MFA_CHALLENGE');

    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'password_changed',
    });
    await this.audit.log({
      action: 'auth.password.reset',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Mot de passe réinitialisé. Reconnectez-vous sur tous vos appareils.' };
  }

  /** Changement de mot de passe (connecté) : révoque les AUTRES sessions. */
  async changePassword(
    user: User,
    currentPassword: string,
    newPassword: string,
    currentFamilyId: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    if (!user.passwordHash) {
      throw new BadRequestException(
        'Ce compte n’a pas de mot de passe (connexion sociale) : utilisez la réinitialisation par courriel pour en définir un.',
      );
    }
    this.lockout.assertNotLocked(user);
    const valid = await verifyPassword(user.passwordHash, currentPassword);
    if (!valid) {
      await this.lockout.registerFailure(user, ctx, 'password');
      throw new BadRequestException('Mot de passe actuel invalide.');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await this.tokens.revokeAllForUser(user.id, currentFamilyId);
    await this.oneTimeTokens.invalidateAll(user.id, 'PASSWORD_RESET');

    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'password_changed',
    });
    await this.audit.log({
      action: 'auth.password.changed',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { message: 'Mot de passe modifié. Les autres sessions ont été déconnectées.' };
  }

  /** TTL humain d'un jeton (pour les courriels). */
  static ttlLabel(purpose: keyof typeof ONE_TIME_TOKEN_TTL_MS, locale: Locale): string {
    const minutes = ONE_TIME_TOKEN_TTL_MS[purpose] / 60_000;
    if (minutes >= 60) {
      const hours = minutes / 60;
      return locale === 'fr' ? `${hours} heures` : `${hours} hours`;
    }
    return `${minutes} minutes`;
  }
}
