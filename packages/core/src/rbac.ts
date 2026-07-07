import { z } from 'zod';

/**
 * RBAC fin de l'admin (tâche 09) — SOURCE DE VÉRITÉ partagée.
 *
 * Le rôle système grossier (`users.role` : CUSTOMER/STAFF/ADMIN) verrouille
 * l'accès à la surface admin et impose la MFA (tâche 05). Par-dessus, ce
 * module décrit des **permissions granulaires** (« ressource.action ») et des
 * **rôles** qui les regroupent. Rôles et permissions sont matérialisés en base
 * (tables roles/permissions/role_permissions, tâche 04) par le seed, puis
 * appliqués côté serveur (gardes NestJS) et côté interface (navigation).
 *
 * Data-driven : ajuster les permissions d'un rôle NON système se fait en base,
 * sans redéploiement. Ce fichier ne fournit que l'ossature et les rôles de
 * départ; il est aussi le contrat que l'admin (web) utilise pour masquer la
 * navigation et les actions.
 */

/** Permission spéciale : accorde TOUT (réservée à super_admin). */
export const PERMISSION_WILDCARD = '*';

/**
 * Catalogue des permissions granulaires. La clé « ressource.action » est
 * stable (persistée, exigée par les gardes) — ne jamais la renommer sans
 * migration de données.
 */
export const ADMIN_PERMISSIONS = [
  { key: 'products.read', description: 'Consulter le catalogue' },
  {
    key: 'products.write',
    description: 'Créer et modifier produits, variantes, traductions, images',
  },
  { key: 'inventory.read', description: 'Consulter les niveaux de stock' },
  { key: 'inventory.write', description: 'Ajuster les stocks et les seuils d’alerte' },
  { key: 'orders.read', description: 'Consulter les commandes' },
  { key: 'orders.write', description: 'Gérer les commandes (statuts, notes, expéditions)' },
  { key: 'orders.refund', description: 'Émettre des remboursements' },
  { key: 'shipments.read', description: 'Consulter les expéditions et le suivi' },
  { key: 'shipments.write', description: 'Créer et mettre à jour les expéditions' },
  { key: 'customers.read', description: 'Consulter les clients' },
  { key: 'customers.write', description: 'Modifier les fiches clients' },
  { key: 'customers.anonymize', description: 'Anonymiser un compte client (Loi 25)' },
  { key: 'promotions.read', description: 'Consulter les promotions et coupons' },
  { key: 'promotions.write', description: 'Créer et modifier promotions et coupons' },
  { key: 'content.read', description: 'Consulter le contenu marketing' },
  { key: 'content.write', description: 'Modifier le contenu marketing (bandeaux, pages)' },
  { key: 'reviews.moderate', description: 'Modérer les avis clients' },
  { key: 'reports.read', description: 'Consulter les rapports et le tableau de bord' },
  { key: 'settings.read', description: 'Consulter les réglages de la boutique' },
  { key: 'settings.write', description: 'Modifier les réglages de la boutique' },
  { key: 'admin_users.read', description: 'Consulter les comptes du personnel et leurs rôles' },
  {
    key: 'admin_users.write',
    description: 'Inviter, attribuer des rôles, désactiver le personnel',
  },
  { key: 'roles.read', description: 'Consulter les rôles et permissions' },
  { key: 'audit.read', description: 'Consulter le journal d’audit' },
] as const satisfies readonly { key: string; description: string }[];

export type AdminPermissionKey = (typeof ADMIN_PERMISSIONS)[number]['key'];

/** Toutes les clés de permission connues (hors joker). */
export const ADMIN_PERMISSION_KEYS: readonly AdminPermissionKey[] = ADMIN_PERMISSIONS.map(
  (permission) => permission.key,
);

export const adminPermissionKeySchema = z.enum(
  ADMIN_PERMISSION_KEYS as [AdminPermissionKey, ...AdminPermissionKey[]],
);

/** Toutes les permissions en lecture seule (rôle « lecture_seule », navigation UI). */
const READ_PERMISSIONS = ADMIN_PERMISSION_KEYS.filter((key) => key.endsWith('.read'));

export interface AdminRoleSeed {
  /** Clé stable exigée par le brief (snake_case). */
  key: string;
  nameFr: string;
  nameEn: string;
  description: string;
  /** Rôles de départ : non supprimables depuis l'admin. */
  isSystem: boolean;
  /** Permissions accordées; [PERMISSION_WILDCARD] = toutes. */
  permissions: readonly string[];
}

/**
 * Rôles de départ (brief tâche 09). super_admin porte le joker; les autres
 * sont cadrés sur leur domaine. « lecture_seule » n'a QUE des permissions de
 * lecture métier — aucune écriture, aucun remboursement, aucune anonymisation,
 * et pas d'accès aux comptes/rôles/audit/réglages.
 */
export const ADMIN_ROLES = [
  {
    key: 'super_admin',
    nameFr: 'Super administrateur',
    nameEn: 'Super Administrator',
    description: 'Accès complet à toutes les fonctions et à tous les réglages.',
    isSystem: true,
    permissions: [PERMISSION_WILDCARD],
  },
  {
    key: 'commandes',
    nameFr: 'Commandes',
    nameEn: 'Orders',
    description: 'Gestion des commandes, expéditions et remboursements.',
    isSystem: true,
    permissions: [
      'orders.read',
      'orders.write',
      'orders.refund',
      'shipments.read',
      'shipments.write',
      'customers.read',
      'reports.read',
    ],
  },
  {
    key: 'catalogue',
    nameFr: 'Catalogue',
    nameEn: 'Catalog',
    description: 'Gestion des produits, variantes et inventaire.',
    isSystem: true,
    permissions: [
      'products.read',
      'products.write',
      'inventory.read',
      'inventory.write',
      'reports.read',
    ],
  },
  {
    key: 'marketing',
    nameFr: 'Marketing',
    nameEn: 'Marketing',
    description: 'Promotions, contenu et modération des avis.',
    isSystem: true,
    permissions: [
      'promotions.read',
      'promotions.write',
      'content.read',
      'content.write',
      'reviews.moderate',
      'reports.read',
    ],
  },
  {
    key: 'lecture_seule',
    nameFr: 'Lecture seule',
    nameEn: 'Read-only',
    description: 'Consultation métier sans aucune action de modification.',
    isSystem: true,
    // Lecture MÉTIER seulement : pas d'accès aux comptes du personnel, aux
    // rôles ni au journal d'audit (surface d'administration sensible).
    permissions: READ_PERMISSIONS.filter(
      (key) => !['audit.read', 'roles.read', 'admin_users.read'].includes(key),
    ),
  },
] as const satisfies readonly AdminRoleSeed[];

export type AdminRoleKey = (typeof ADMIN_ROLES)[number]['key'];

/**
 * Un ensemble de permissions accorde-t-il la permission demandée ?
 * Le joker `*` accorde tout. Utilisé par la garde serveur ET l'UI.
 */
export function grantsPermission(granted: Iterable<string>, required: string): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return set.has(PERMISSION_WILDCARD) || set.has(required);
}
