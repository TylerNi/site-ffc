import {
  ConflictException,
  Inject,
  Injectable,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { type User } from '@prisma/client';
import { type Locale } from '@ffc/core';
import { PrismaService } from '../../../database';
import { AuditService } from '../../audit/audit.service';
import { AuthService, type LoginResult } from '../auth.service';
import { type RequestContext } from '../token.service';
import {
  OIDC_VERIFIERS,
  type OidcIdentity,
  type OidcVerifier,
  type SocialProvider,
} from './oidc-verifier';

export interface SocialLoginInput {
  idToken: string;
  guestCartToken?: string;
  /** Locale du nouveau compte si le fournisseur n'en donne pas. */
  locale: Locale;
  /** Apple ne transmet le nom qu'une fois, côté client — relayé ici. */
  firstName?: string;
  lastName?: string;
}

/**
 * Connexions sociales Google et Apple (OIDC, tâche 05).
 *
 * Le client (web ou mobile) obtient un ID token chez le fournisseur puis
 * le présente ici; l'API vérifie signature/émetteur/audience via JWKS.
 *
 * Liaison avec un compte courriel existant : UNIQUEMENT si le fournisseur
 * atteste le courriel (`email_verified`) ET que le compte local a lui
 * aussi vérifié cette adresse — sinon un compte local jamais vérifié
 * pourrait être capturé par quiconque enregistre l'adresse chez Google.
 *
 * Conformité Apple : « Sign in with Apple » est offert dès qu'un autre
 * login social l'est — obligatoire sur iOS (App Store Review 4.8).
 *
 * Un compte MFA reste soumis au défi TOTP même en connexion sociale.
 */
@Injectable()
export class SocialAuthService {
  private readonly verifiers: Map<SocialProvider, OidcVerifier>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(OIDC_VERIFIERS) verifiers: OidcVerifier[],
  ) {
    this.verifiers = new Map(verifiers.map((verifier) => [verifier.provider, verifier]));
  }

  async login(
    provider: SocialProvider,
    input: SocialLoginInput,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const verifier = this.verifiers.get(provider);
    if (!verifier) {
      throw new NotImplementedException(
        `La connexion ${provider} n'est pas configurée sur ce déploiement.`,
      );
    }
    const identity = await verifier.verify(input.idToken);
    const user = await this.resolveUser(identity, input, ctx);

    if (user.mfaEnabled) {
      return this.auth.issueMfaChallenge(user, ctx);
    }
    const tokens = await this.auth.completeLogin(user, ctx, {
      guestCartToken: input.guestCartToken,
      method: provider,
    });
    return { mfaRequired: false, user, tokens };
  }

  private async resolveUser(
    identity: OidcIdentity,
    input: SocialLoginInput,
    ctx: RequestContext,
  ): Promise<User> {
    const providerIdField = identity.provider === 'google' ? 'googleId' : 'appleId';

    const byProviderId = await this.prisma.user.findUnique({
      where: { [providerIdField]: identity.subject } as { googleId: string } | { appleId: string },
    });
    if (byProviderId) {
      if (byProviderId.status !== 'ACTIVE') {
        throw new UnauthorizedException('Connexion refusée.');
      }
      return byProviderId;
    }

    if (!identity.email || !identity.emailVerified) {
      throw new UnauthorizedException(
        `${identity.provider === 'google' ? 'Google' : 'Apple'} n'a pas confirmé cette adresse courriel — connexion refusée.`,
      );
    }

    const byEmail = await this.prisma.user.findUnique({ where: { email: identity.email } });
    if (byEmail) {
      if (byEmail.status !== 'ACTIVE') {
        throw new UnauthorizedException('Connexion refusée.');
      }
      if (!byEmail.emailVerifiedAt) {
        // Compte local jamais vérifié : liaison automatique refusée
        // (protection contre la capture de comptes dormants).
        throw new ConflictException(
          'Un compte existe déjà pour ce courriel. Connectez-vous par mot de passe (ou réinitialisez-le), puis réessayez.',
        );
      }
      const linked = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { [providerIdField]: identity.subject },
      });
      await this.audit.log({
        action: 'auth.social.linked',
        actorId: linked.id,
        actorEmail: linked.email,
        entityType: 'user',
        entityId: linked.id,
        metadata: { provider: identity.provider },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return linked;
    }

    // Nouveau compte : le fournisseur atteste le courriel → déjà vérifié.
    const created = await this.prisma.user.create({
      data: {
        email: identity.email,
        emailVerifiedAt: new Date(),
        [providerIdField]: identity.subject,
        firstName: identity.givenName ?? input.firstName?.trim() ?? null,
        lastName: identity.familyName ?? input.lastName?.trim() ?? null,
        locale: input.locale,
      },
    });
    await this.audit.log({
      action: 'auth.register',
      actorId: created.id,
      actorEmail: created.email,
      entityType: 'user',
      entityId: created.id,
      metadata: { provider: identity.provider },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  }
}
