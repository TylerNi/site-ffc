import { Injectable } from '@nestjs/common';
import { grantsPermission } from '@ffc/core';
import { PrismaService } from '../../database';

export interface AdminRoleSummary {
  key: string;
  nameFr: string;
  nameEn: string;
}

/**
 * Permissions effectives d'un compte admin (tâche 09) : union des permissions
 * de tous ses rôles assignés (`user_role_assignments`). Le joker « * »
 * (super_admin) accorde tout.
 *
 * Source de vérité en base : les rôles restent ajustables sans redéploiement.
 * Une requête par accès protégé — négligeable à notre échelle (peu de comptes
 * admin, chemins non chauds), et toujours frais (aucun cache périmé de droits).
 */
@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ensemble des clés de permission accordées à l'utilisateur. */
  async effectivePermissions(userId: string): Promise<Set<string>> {
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { userId },
      select: {
        role: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
      },
    });
    const keys = new Set<string>();
    for (const assignment of assignments) {
      for (const rolePermission of assignment.role.permissions) {
        keys.add(rolePermission.permission.key);
      }
    }
    return keys;
  }

  /** Rôles assignés (pour le profil admin et l'affichage). */
  async rolesOf(userId: string): Promise<AdminRoleSummary[]> {
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { userId },
      select: { role: { select: { key: true, nameFr: true, nameEn: true } } },
      orderBy: { role: { key: 'asc' } },
    });
    return assignments.map((assignment) => assignment.role);
  }

  /** L'utilisateur détient-il la permission demandée ? (joker pris en compte) */
  async can(userId: string, permission: string): Promise<boolean> {
    return grantsPermission(await this.effectivePermissions(userId), permission);
  }
}
