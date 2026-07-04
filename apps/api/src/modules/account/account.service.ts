import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type User } from '@prisma/client';
import { type Env } from '../../config/env';
import { anonymizeUser, PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { OneTimeTokenService } from '../auth/one-time-token.service';
import { type RequestContext, TokenService } from '../auth/token.service';

/**
 * Droits Loi 25 (tâche 05) : accès/portabilité (export JSON des
 * renseignements personnels) et droit à l'effacement (suppression de
 * compte par ANONYMISATION — stratégie de la tâche 04 : l'historique
 * comptable reste, l'identité disparaît).
 *
 * Confirmation forte de la suppression : session valide ET jeton à usage
 * unique reçu par courriel (prouve le contrôle de l'adresse) — même pour
 * les comptes sans mot de passe (connexion sociale).
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly webUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oneTimeTokens: OneTimeTokenService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.webUrl = config.get('APP_WEB_URL', { infer: true }).replace(/\/$/, '');
  }

  /* ------------------------------- Export ------------------------------ */

  /** Renseignements personnels détenus, en JSON lisible (Loi 25, art. 27). */
  async exportData(user: User, ctx: RequestContext): Promise<Record<string, unknown>> {
    const [
      addresses,
      devices,
      sessions,
      orders,
      equipment,
      aiIdentifications,
      reviews,
      replenishmentPlans,
      notificationPreferences,
      notifications,
      couponRedemptions,
    ] = await Promise.all([
      this.prisma.address.findMany({ where: { userId: user.id } }),
      this.prisma.userDevice.findMany({ where: { userId: user.id } }),
      this.prisma.refreshToken.findMany({
        where: { userId: user.id },
        select: { familyId: true, ip: true, userAgent: true, createdAt: true, revokedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.order.findMany({
        where: { userId: user.id },
        include: { items: true, shipments: true, invoices: true },
        orderBy: { placedAt: 'desc' },
      }),
      this.prisma.userEquipment.findMany({ where: { userId: user.id } }),
      this.prisma.aiIdentification.findMany({
        where: { userId: user.id },
        select: {
          id: true,
          imageKey: true,
          status: true,
          extraction: true,
          confidence: true,
          createdAt: true,
          purgeAt: true,
          purgedAt: true,
        },
      }),
      this.prisma.review.findMany({ where: { userId: user.id } }),
      this.prisma.replenishmentPlan.findMany({ where: { userId: user.id } }),
      this.prisma.notificationPreference.findMany({ where: { userId: user.id } }),
      this.prisma.notification.findMany({
        where: { userId: user.id },
        select: {
          templateKey: true,
          channel: true,
          status: true,
          subject: true,
          destination: true,
          sentAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.couponRedemption.findMany({ where: { userId: user.id } }),
    ]);

    await this.audit.log({
      action: 'user.export',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      exportedAt: new Date().toISOString(),
      format: 'ffc-export-v1',
      profile: {
        id: user.id,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        locale: user.locale,
        mfaEnabled: user.mfaEnabled,
        googleLinked: user.googleId !== null,
        appleLinked: user.appleId !== null,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        deletionRequestedAt: user.deletionRequestedAt,
      },
      addresses,
      devices,
      sessions,
      orders,
      equipment,
      aiIdentifications,
      reviews,
      replenishmentPlans,
      notificationPreferences,
      notifications,
      couponRedemptions,
    };
  }

  /* ----------------------------- Suppression --------------------------- */

  async requestDeletion(user: User, ctx: RequestContext): Promise<{ message: string }> {
    if (user.deletionRequestedAt === null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { deletionRequestedAt: new Date() },
      });
    }
    const { raw } = await this.oneTimeTokens.issue(user.id, 'ACCOUNT_DELETION', ctx);
    await this.mail.send({
      userId: user.id,
      to: user.email,
      locale: user.locale,
      templateKey: 'account_deletion_request',
      variables: { ttl: '30 minutes' },
      secretVariables: {
        confirmUrl: `${this.webUrl}/${user.locale}/compte/suppression?token=${raw}`,
      },
    });
    await this.audit.log({
      action: 'user.deletion_requested',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return {
      message:
        'Un courriel de confirmation vient d’être envoyé. La suppression ne sera effectuée qu’après confirmation (lien valide 30 minutes).',
    };
  }

  async confirmDeletion(
    user: User,
    rawToken: string,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const token = await this.oneTimeTokens.consume(rawToken, 'ACCOUNT_DELETION');
    if (!token || token.userId !== user.id) {
      throw new BadRequestException('Lien invalide ou expiré.');
    }

    // Adresse et locale capturées AVANT l'effacement (le courriel de
    // confirmation part après, sans trace en base — voir MailService).
    const { email, locale } = user;

    // L'IP/user-agent de la confirmation, consignés AVANT l'anonymisation
    // (qui écrit son propre événement `user.anonymize`, sans contexte réseau).
    await this.audit.log({
      action: 'user.deletion_confirmed',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const result = await anonymizeUser(this.prisma, user.id, {
      actorType: 'user',
      actorId: user.id,
      reason: 'demande du client via API (confirmation courriel)',
    });

    // Ceinture et bretelles : l'anonymisation supprime déjà les refresh
    // tokens; on révoque aussi tout ce qui resterait.
    await this.tokens.revokeAllForUser(user.id);

    if (result.s3KeysToPurge.length > 0) {
      // La purge S3 sera outillée avec les uploads (tâche 17); les clés
      // sont dans l'audit `user.anonymize` et journalisées ici.
      this.logger.warn(
        `Suppression ${user.id} : ${result.s3KeysToPurge.length} clé(s) S3 à purger — ${result.s3KeysToPurge.join(', ')}`,
      );
    }

    await this.mail.send({
      userId: null,
      to: email,
      locale,
      templateKey: 'account_deleted',
      recordTrace: false,
    });

    return {
      message:
        'Compte supprimé : vos données personnelles ont été effacées. L’historique de commandes est conservé de façon anonyme (obligations comptables).',
    };
  }
}
