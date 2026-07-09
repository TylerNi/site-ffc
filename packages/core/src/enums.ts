import { z } from 'zod';

/**
 * Enums partagés de la plateforme — source de vérité côté TypeScript.
 *
 * Chaque enum ci-dessous est dupliqué dans le schéma Prisma
 * (`apps/api/prisma/schema.prisma`), car Prisma ne peut pas importer de
 * code TypeScript. La synchronisation est garantie par un test automatisé
 * (`apps/api/test/enums-sync.test.ts`) qui compare ces constantes au DMMF
 * du client Prisma généré : toute divergence fait échouer la CI.
 *
 * Convention : valeurs en SCREAMING_SNAKE_CASE, identiques dans Prisma et
 * en base (PostgreSQL enum types).
 */

/* ------------------------------------------------------------------ */
/* Comptes                                                             */
/* ------------------------------------------------------------------ */

/** Rôle système (grossier). Le RBAC fin passe par les tables roles/permissions. */
export const USER_ROLES = ['CUSTOMER', 'STAFF', 'ADMIN'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** ANONYMIZED : compte effacé au sens de la Loi 25 (voir docs/database.md). */
export const USER_STATUSES = ['ACTIVE', 'DISABLED', 'ANONYMIZED'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Plateformes des appareils enregistrés (jetons push). */
export const DEVICE_PLATFORMS = ['IOS', 'ANDROID', 'WEB'] as const;
export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/**
 * Finalités des jetons à usage unique (table one_time_tokens, tâche 05).
 * Chaque jeton est haché en base, expire, et n'est consommable qu'une fois :
 * vérification de courriel, réinitialisation de mot de passe, défi MFA au
 * login, confirmation forte de suppression de compte (Loi 25), invitation
 * d'un compte du personnel à l'admin (tâche 09).
 */
export const ONE_TIME_TOKEN_PURPOSES = [
  'EMAIL_VERIFICATION',
  'PASSWORD_RESET',
  'MFA_CHALLENGE',
  'ACCOUNT_DELETION',
  'ADMIN_INVITATION',
] as const;
export const oneTimeTokenPurposeSchema = z.enum(ONE_TIME_TOKEN_PURPOSES);
export type OneTimeTokenPurpose = z.infer<typeof oneTimeTokenPurposeSchema>;

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** Mouvements d'inventaire : la quantité est signée, le type qualifie la cause. */
export const INVENTORY_MOVEMENT_TYPES = ['RECEIPT', 'SALE', 'RETURN', 'ADJUSTMENT'] as const;
export const inventoryMovementTypeSchema = z.enum(INVENTORY_MOVEMENT_TYPES);
export type InventoryMovementType = z.infer<typeof inventoryMovementTypeSchema>;

/* ------------------------------------------------------------------ */
/* Compatibilité équipements / IA                                      */
/* ------------------------------------------------------------------ */

export const EQUIPMENT_KINDS = [
  'FURNACE',
  'AIR_HANDLER',
  'HRV_ERV',
  'AIR_CONDITIONER',
  'OTHER',
] as const;
export const equipmentKindSchema = z.enum(EQUIPMENT_KINDS);
export type EquipmentKind = z.infer<typeof equipmentKindSchema>;

/** Provenance d'une entrée de la table de correspondance modèle ↔ filtre. */
export const COMPATIBILITY_SOURCES = ['MANUAL', 'AI', 'IMPORT'] as const;
export const compatibilitySourceSchema = z.enum(COMPATIBILITY_SOURCES);
export type CompatibilitySource = z.infer<typeof compatibilitySourceSchema>;

/**
 * Cycle de vie d'une identification IA (tâches 17–18) :
 * PENDING → PROCESSING → COMPLETED (confiance haute, correspondance auto)
 *                      → NEEDS_REVIEW (confiance basse → file de révision admin)
 *                      → FAILED (erreur du pipeline)
 * NEEDS_REVIEW → CONFIRMED | REJECTED (décision admin).
 */
export const AI_IDENTIFICATION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'REJECTED',
  'FAILED',
] as const;
export const aiIdentificationStatusSchema = z.enum(AI_IDENTIFICATION_STATUSES);
export type AiIdentificationStatus = z.infer<typeof aiIdentificationStatusSchema>;

/* ------------------------------------------------------------------ */
/* Ventes                                                              */
/* ------------------------------------------------------------------ */

/** Devises acceptées. Tous les montants sont en cents (Int). */
export const CURRENCIES = ['CAD', 'USD'] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;

export const CART_STATUSES = ['ACTIVE', 'CONVERTED', 'ABANDONED'] as const;
export const cartStatusSchema = z.enum(CART_STATUSES);
export type CartStatus = z.infer<typeof cartStatusSchema>;

/**
 * Statuts de commande :
 * PENDING → PAID → PROCESSING → SHIPPED → DELIVERED
 * CANCELLED (avant expédition) · REFUNDED / PARTIALLY_REFUNDED (après paiement).
 * Le détail de la machine à états arrive en tâche 12 ; l'historique complet
 * vit dans order_status_history.
 */
export const ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** Canal d'origine d'une commande. SUBSCRIPTION est réservé aux futurs abonnements Stripe Billing. */
export const ORDER_CHANNELS = ['WEB', 'MOBILE', 'ADMIN', 'SUBSCRIPTION'] as const;
export const orderChannelSchema = z.enum(ORDER_CHANNELS);
export type OrderChannel = z.infer<typeof orderChannelSchema>;

export const PAYMENT_PROVIDERS = ['STRIPE', 'MANUAL'] as const;
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

/** Aligné sur les états Stripe PaymentIntent, sans y être couplé. */
export const PAYMENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export const refundStatusSchema = z.enum(REFUND_STATUSES);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

/** Factures et notes de crédit partagent la table invoices (séries distinctes). */
export const INVOICE_KINDS = ['INVOICE', 'CREDIT_NOTE'] as const;
export const invoiceKindSchema = z.enum(INVOICE_KINDS);
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;

/** VOIDED conserve le numéro (jamais de trou dans la série). */
export const INVOICE_STATUSES = ['ISSUED', 'VOIDED'] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const COUPON_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING'] as const;
export const couponTypeSchema = z.enum(COUPON_TYPES);
export type CouponType = z.infer<typeof couponTypeSchema>;

/* ------------------------------------------------------------------ */
/* Expédition                                                          */
/* ------------------------------------------------------------------ */

/**
 * Transporteurs intégrés via ShipStation (tâches 13–14). Purolator n'est
 * accessible QUE par ShipStation (pas d'API de repérage directe côté tâche 14).
 */
export const CARRIERS = ['CANADA_POST', 'NATIONEX', 'CANPAR', 'PUROLATOR', 'OTHER'] as const;
export const carrierSchema = z.enum(CARRIERS);
export type Carrier = z.infer<typeof carrierSchema>;

/**
 * Statuts d'expédition (brief tâche 04) : créé, pris en charge, en transit,
 * en livraison, livré, exception, retourné.
 */
export const SHIPMENT_STATUSES = [
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
  'RETURNED',
] as const;
export const shipmentStatusSchema = z.enum(SHIPMENT_STATUSES);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

/**
 * État de la synchronisation d'une commande vers ShipStation (tâche 13).
 * `SYNC_FAILED` = retentatives épuisées : la commande apparaît dans la file
 * d'échec de l'admin avec sa cause, avec l'action « repousser ».
 * `SKIPPED` = plus rien à pousser (commande annulée avant toute poussée).
 */
export const SHIPSTATION_SYNC_STATUSES = [
  'PENDING',
  'SYNCED',
  'SYNC_FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;
export const shipstationSyncStatusSchema = z.enum(SHIPSTATION_SYNC_STATUSES);
export type ShipstationSyncStatus = z.infer<typeof shipstationSyncStatusSchema>;

/** Opération en attente sur la file de synchronisation ShipStation. */
export const SHIPSTATION_SYNC_OPERATIONS = ['CREATE', 'CANCEL'] as const;
export const shipstationSyncOperationSchema = z.enum(SHIPSTATION_SYNC_OPERATIONS);
export type ShipstationSyncOperation = z.infer<typeof shipstationSyncOperationSchema>;

/* ------------------------------------------------------------------ */
/* Notifications / rappels                                             */
/* ------------------------------------------------------------------ */

/** Catégories de consentement (LCAP) — les préférences se gèrent par catégorie × canal. */
export const NOTIFICATION_CATEGORIES = [
  'TRANSACTIONAL',
  'REPLENISHMENT_REMINDER',
  'REVIEW_REQUEST',
  'MARKETING',
] as const;
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const NOTIFICATION_CHANNELS = ['EMAIL', 'PUSH'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/** SKIPPED : non envoyée (opt-out, préférence désactivée, jeton invalide…). */
export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const REPLENISHMENT_PLAN_STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED'] as const;
export const replenishmentPlanStatusSchema = z.enum(REPLENISHMENT_PLAN_STATUSES);
export type ReplenishmentPlanStatus = z.infer<typeof replenishmentPlanStatusSchema>;

/* ------------------------------------------------------------------ */
/* Avis                                                                */
/* ------------------------------------------------------------------ */

/** Statuts de modération d'avis. */
export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/* ------------------------------------------------------------------ */
/* Technique                                                           */
/* ------------------------------------------------------------------ */

/** IGNORED : événement reçu mais volontairement non traité (type inconnu, rejoué…). */
export const WEBHOOK_EVENT_STATUSES = ['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED'] as const;
export const webhookEventStatusSchema = z.enum(WEBHOOK_EVENT_STATUSES);
export type WebhookEventStatus = z.infer<typeof webhookEventStatusSchema>;

/* ------------------------------------------------------------------ */
/* Registre Prisma ↔ core                                              */
/* ------------------------------------------------------------------ */

/**
 * Registre { nom d'enum Prisma → valeurs } utilisé par le test de
 * synchronisation. Toute nouvelle enum partagée doit être ajoutée ici
 * ET dans schema.prisma (même nom, mêmes valeurs).
 *
 * `Locale` vit dans ./locales (fr/en, en minuscules — valeurs d'URL).
 */
export const PRISMA_ENUMS = {
  UserRole: USER_ROLES,
  UserStatus: USER_STATUSES,
  DevicePlatform: DEVICE_PLATFORMS,
  OneTimeTokenPurpose: ONE_TIME_TOKEN_PURPOSES,
  ProductStatus: PRODUCT_STATUSES,
  InventoryMovementType: INVENTORY_MOVEMENT_TYPES,
  EquipmentKind: EQUIPMENT_KINDS,
  CompatibilitySource: COMPATIBILITY_SOURCES,
  AiIdentificationStatus: AI_IDENTIFICATION_STATUSES,
  Currency: CURRENCIES,
  CartStatus: CART_STATUSES,
  OrderStatus: ORDER_STATUSES,
  OrderChannel: ORDER_CHANNELS,
  PaymentProvider: PAYMENT_PROVIDERS,
  PaymentStatus: PAYMENT_STATUSES,
  RefundStatus: REFUND_STATUSES,
  InvoiceKind: INVOICE_KINDS,
  InvoiceStatus: INVOICE_STATUSES,
  CouponType: COUPON_TYPES,
  Carrier: CARRIERS,
  ShipmentStatus: SHIPMENT_STATUSES,
  ShipstationSyncStatus: SHIPSTATION_SYNC_STATUSES,
  ShipstationSyncOperation: SHIPSTATION_SYNC_OPERATIONS,
  NotificationCategory: NOTIFICATION_CATEGORIES,
  NotificationChannel: NOTIFICATION_CHANNELS,
  NotificationStatus: NOTIFICATION_STATUSES,
  ReplenishmentPlanStatus: REPLENISHMENT_PLAN_STATUSES,
  ReviewStatus: REVIEW_STATUSES,
  WebhookEventStatus: WEBHOOK_EVENT_STATUSES,
} as const satisfies Record<string, readonly string[]>;
