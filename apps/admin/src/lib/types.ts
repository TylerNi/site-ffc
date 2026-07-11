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

/* ------------------------- ShipStation (tâche 13) ------------------------- */

export type ShipstationSyncStatus = 'PENDING' | 'SYNCED' | 'SYNC_FAILED' | 'CANCELLED' | 'SKIPPED';

export interface ShipstationSync {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  totalCents: number;
  currency: string;
  paidAt: string | null;
  status: ShipstationSyncStatus;
  operation: 'CREATE' | 'CANCEL';
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  shipstationOrderId: string | null;
  updatedAt: string;
}

export interface ShipstationSyncPage {
  items: ShipstationSync[];
  nextCursor: string | null;
  counts: Record<ShipstationSyncStatus, number>;
  /** Les clés API ShipStation sont configurées sur le serveur. */
  configured: boolean;
}

/* --------------------------- Catalogue (tâche 10) -------------------------- */

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type AdminLocale = 'fr' | 'en';

export interface BrandRef {
  id: string;
  slug: string;
  name: string;
}

export interface CategoryRef {
  id: string;
  name: string | null;
}

export interface ProductTranslation {
  locale: AdminLocale;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
}

export interface InventorySummary {
  quantityOnHand: number;
  quantityReserved: number;
  lowStockThreshold: number | null;
}

export interface ProductVariant {
  id: string;
  sku: string;
  barcode: string | null;
  nominalLabel: string;
  nominalWidthIn: number;
  nominalHeightIn: number;
  nominalDepthIn: number;
  actualWidthIn: number;
  actualHeightIn: number;
  actualDepthIn: number;
  merv: number | null;
  packSize: number;
  priceCents: number;
  compareAtPriceCents: number | null;
  costCents: number | null;
  currency: 'CAD' | 'USD';
  weightGrams: number | null;
  isActive: boolean;
  position: number;
  inventory: InventorySummary | null;
}

export interface ProductImage {
  id: string;
  url: string;
  altFr: string | null;
  altEn: string | null;
  width: number | null;
  height: number | null;
  position: number;
  variantId: string | null;
}

export interface ProductListItem {
  id: string;
  status: ProductStatus;
  isFeatured: boolean;
  brand: BrandRef;
  category: CategoryRef | null;
  translatedLocales: AdminLocale[];
  name: string;
  image: ProductImage | null;
  variantCount: number;
  priceFromCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListPage {
  items: ProductListItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProductDetail {
  id: string;
  status: ProductStatus;
  isFeatured: boolean;
  brand: BrandRef;
  category: CategoryRef | null;
  translations: ProductTranslation[];
  variants: ProductVariant[];
  images: ProductImage[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminBrand {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  isActive: boolean;
  productCount: number;
}

export interface CategoryTranslation {
  locale: AdminLocale;
  name: string;
  slug: string;
  description: string | null;
}

export interface CategoryNode {
  id: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
  translations: CategoryTranslation[];
  children: CategoryNode[];
}

export interface InventoryItem {
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  nominalLabel: string;
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
  lowStockThreshold: number | null;
  isLowStock: boolean;
}

export interface InventoryPage {
  items: InventoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type InventoryMovementType = 'RECEIPT' | 'SALE' | 'RETURN' | 'ADJUSTMENT';

export interface InventoryMovement {
  id: string;
  type: InventoryMovementType;
  quantity: number;
  reason: string | null;
  orderId: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface InventoryMovementPage {
  items: InventoryMovement[];
  nextCursor: string | null;
}
