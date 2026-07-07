/** Formes des réponses de l'API admin (miroir des DTO NestJS, tâche 09). */

export interface AdminRoleSummary {
  key: string;
  nameFr: string;
  nameEn: string;
}

export interface AdminProfile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roles: AdminRoleSummary[];
  permissions: string[];
  mfaEnabled: boolean;
}

export interface AdminSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  profile: AdminProfile;
}

export interface AdminUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: 'ACTIVE' | 'DISABLED' | 'ANONYMIZED';
  role: 'CUSTOMER' | 'STAFF' | 'ADMIN';
  mfaEnabled: boolean;
  roles: AdminRoleSummary[];
  lastLoginAt: string | null;
  invitedPendingAt: string | null;
  createdAt: string;
}

export interface AdminRole {
  key: string;
  nameFr: string;
  nameEn: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export interface DashboardSummary {
  salesTodayCents: number;
  ordersTodayCount: number;
  ordersToShip: number;
  pendingReviews: number;
  aiReviewQueue: number;
  lowStock: number;
  currency: string;
}

export interface AuditLogEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
}
