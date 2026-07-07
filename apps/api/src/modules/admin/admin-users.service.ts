import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';
import { type Env } from '../../config/env';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { OneTimeTokenService } from '../auth/one-time-token.service';
import { type RequestContext, TokenService } from '../auth/token.service';
import { MailService } from '../mail/mail.service';
import {
  type AcceptInvitationDto,
  type AdminUserDto,
  type InviteAdminDto,
  type PermissionDto,
  type RoleDto,
} from './dto/admin.dto';

/** Rôles système grossiers autorisés sur la surface admin. */
const STAFF_ROLES: readonly User['role'][] = ['STAFF', 'ADMIN'];

const userWithRoles = Prisma.validator<Prisma.UserDefaultArgs>()({
  include: { roleAssignments: { include: { role: true } } },
});
type UserWithRoles = Prisma.UserGetPayload<typeof userWithRoles>;

/**
 * Gestion des comptes du personnel (tâche 09) : invitation par courriel (jeton
 * à usage unique), attribution de rôles, désactivation immédiate (révocation
 * des sessions). Les actions consignent un audit détaillé avant/après.
 */
@Injectable()
export class AdminUsersService {
  private readonly adminUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oneTimeTokens: OneTimeTokenService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.adminUrl = config.get('APP_ADMIN_URL', { infer: true }).replace(/\/$/, '');
  }

  /* --------------------------------- Lecture --------------------------------- */

  async list(): Promise<AdminUserDto[]> {
    const users = await this.prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      orderBy: { createdAt: 'asc' },
      ...userWithRoles,
    });
    return users.map((user) => this.toDto(user));
  }

  async listRoles(): Promise<RoleDto[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: { permissions: { include: { permission: true } } },
    });
    return roles.map((role) => ({
      key: role.key,
      nameFr: role.nameFr,
      nameEn: role.nameEn,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map((link) => link.permission.key).sort(),
    }));
  }

  async listPermissions(): Promise<PermissionDto[]> {
    const permissions = await this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
    return permissions.map((permission) => ({
      key: permission.key,
      description: permission.description,
    }));
  }

  /* ------------------------------- Invitation -------------------------------- */

  /**
   * Invite une personne : crée (ou ré-invite) un compte du personnel SANS mot
   * de passe, lui attribue des rôles, et envoie un lien d'acceptation à usage
   * unique. Le compte ne peut pas se connecter tant qu'il n'a pas défini son
   * mot de passe (puis activé sa MFA).
   */
  async invite(actor: User, dto: InviteAdminDto, ctx: RequestContext): Promise<AdminUserDto> {
    const email = dto.email.trim().toLowerCase();
    const roles = await this.resolveRoles(dto.roleKeys);
    const locale = dto.locale ?? actor.locale;

    const existing = await this.prisma.user.findUnique({ where: { email } });
    let target: User;
    if (existing) {
      const pending =
        existing.status === 'ACTIVE' && existing.role === 'STAFF' && existing.passwordHash === null;
      if (!pending) {
        throw new ConflictException('Un compte existe déjà pour cette adresse.');
      }
      target = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          firstName: dto.firstName ?? existing.firstName,
          lastName: dto.lastName ?? existing.lastName,
          locale,
        },
      });
    } else {
      target = await this.prisma.user.create({
        data: {
          email,
          role: 'STAFF',
          status: 'ACTIVE',
          locale,
          firstName: dto.firstName ?? null,
          lastName: dto.lastName ?? null,
        },
      });
    }

    await this.replaceRoleAssignments(target.id, roles, actor.id);

    const { raw } = await this.oneTimeTokens.issue(target.id, 'ADMIN_INVITATION', ctx);
    await this.mail.send({
      userId: target.id,
      to: email,
      locale,
      templateKey: 'admin_invitation',
      variables: {
        inviter: actor.email,
        roles: roles.map((role) => (locale === 'fr' ? role.nameFr : role.nameEn)).join(', '),
        ttl: locale === 'fr' ? '7 jours' : '7 days',
      },
      secretVariables: { acceptUrl: `${this.adminUrl}/${locale}/invitation?token=${raw}` },
    });

    await this.audit.log({
      action: 'admin.users.invited',
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: 'user',
      entityId: target.id,
      after: { email, roleKeys: roles.map((role) => role.key) },
      ...ctx,
    });

    return this.toDto(await this.loadWithRoles(target.id));
  }

  /** Accepte une invitation : définit le mot de passe et active le compte. */
  async acceptInvitation(
    dto: AcceptInvitationDto,
    ctx: RequestContext,
  ): Promise<{ message: string }> {
    const token = await this.oneTimeTokens.consume(dto.token, 'ADMIN_INVITATION');
    if (!token) throw new BadRequestException('Invitation invalide ou expirée.');

    const user = await this.prisma.user.findUnique({ where: { id: token.userId } });
    if (!user || user.status !== 'ACTIVE' || !STAFF_ROLES.includes(user.role)) {
      throw new BadRequestException('Invitation invalide ou expirée.');
    }

    const passwordHash = await hashPassword(dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        firstName: dto.firstName ?? user.firstName,
        lastName: dto.lastName ?? user.lastName,
        // Le lien reçu par courriel prouve le contrôle de l'adresse.
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });

    await this.audit.log({
      action: 'admin.users.invitation_accepted',
      actorId: user.id,
      actorEmail: user.email,
      entityType: 'user',
      entityId: user.id,
      ...ctx,
    });

    return {
      message:
        'Compte activé. Activez la double authentification (MFA) sur votre compte, puis connectez-vous à l’administration.',
    };
  }

  /* --------------------------------- Rôles ----------------------------------- */

  /** Remplace l'ensemble des rôles d'un compte du personnel (audité avant/après). */
  async assignRoles(
    actor: User,
    userId: string,
    roleKeys: string[],
    ctx: RequestContext,
  ): Promise<AdminUserDto> {
    const before = await this.loadStaffOrThrow(userId);
    const roles = await this.resolveRoles(roleKeys);
    await this.replaceRoleAssignments(userId, roles, actor.id);

    await this.audit.log({
      action: 'admin.users.roles_update',
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: 'user',
      entityId: userId,
      before: { roleKeys: before.roleAssignments.map((assignment) => assignment.role.key) },
      after: { roleKeys: roles.map((role) => role.key) },
      ...ctx,
    });

    return this.toDto(await this.loadWithRoles(userId));
  }

  /* ----------------------------- Activation ---------------------------------- */

  /** Désactivation immédiate : statut DISABLED + révocation de toutes les sessions. */
  async deactivate(actor: User, userId: string, ctx: RequestContext): Promise<AdminUserDto> {
    if (userId === actor.id) {
      throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte.');
    }
    const target = await this.loadStaffOrThrow(userId);
    if (target.status !== 'DISABLED') {
      await this.prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    }
    const revokedSessions = await this.tokens.revokeAllForUser(userId);

    await this.audit.log({
      action: 'admin.users.deactivated',
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: 'user',
      entityId: userId,
      before: { status: target.status },
      after: { status: 'DISABLED' },
      metadata: { revokedSessions },
      ...ctx,
    });

    return this.toDto(await this.loadWithRoles(userId));
  }

  /** Réactive un compte désactivé. */
  async reactivate(actor: User, userId: string, ctx: RequestContext): Promise<AdminUserDto> {
    const target = await this.loadStaffOrThrow(userId);
    if (target.status === 'DISABLED') {
      await this.prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    }
    await this.audit.log({
      action: 'admin.users.reactivated',
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: 'user',
      entityId: userId,
      before: { status: target.status },
      after: { status: 'ACTIVE' },
      ...ctx,
    });
    return this.toDto(await this.loadWithRoles(userId));
  }

  /* --------------------------------- Aides ----------------------------------- */

  private async resolveRoles(
    keys: string[],
  ): Promise<{ id: string; key: string; nameFr: string; nameEn: string }[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const roles = await this.prisma.role.findMany({
      where: { key: { in: unique } },
      select: { id: true, key: true, nameFr: true, nameEn: true },
    });
    if (roles.length !== unique.length) {
      const found = new Set(roles.map((role) => role.key));
      const missing = unique.filter((key) => !found.has(key));
      throw new BadRequestException(`Rôle(s) inconnu(s) : ${missing.join(', ')}.`);
    }
    return roles;
  }

  private async replaceRoleAssignments(
    userId: string,
    roles: { id: string }[],
    assignedByUserId: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.userRoleAssignment.deleteMany({ where: { userId } }),
      this.prisma.userRoleAssignment.createMany({
        data: roles.map((role) => ({ userId, roleId: role.id, assignedByUserId })),
        skipDuplicates: true,
      }),
    ]);
  }

  private async loadStaffOrThrow(userId: string): Promise<UserWithRoles> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, ...userWithRoles });
    if (!user || !STAFF_ROLES.includes(user.role) || user.status === 'ANONYMIZED') {
      throw new NotFoundException('Compte du personnel introuvable.');
    }
    return user;
  }

  private async loadWithRoles(userId: string): Promise<UserWithRoles> {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, ...userWithRoles });
  }

  private toDto(user: UserWithRoles): AdminUserDto {
    const pending = user.passwordHash === null && user.emailVerifiedAt === null;
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      role: user.role,
      mfaEnabled: user.mfaEnabled,
      roles: user.roleAssignments.map((assignment) => ({
        key: assignment.role.key,
        nameFr: assignment.role.nameFr,
        nameEn: assignment.role.nameEn,
      })),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      invitedPendingAt: pending ? user.createdAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
