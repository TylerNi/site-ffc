import { type Prisma, type PrismaClient } from '@prisma/client';

/**
 * Anonymisation d'un compte client — droit à l'effacement de la Loi 25.
 *
 * Stratégie (détaillée dans docs/database.md) : les données PERSONNELLES sont
 * effacées ou réduites, mais l'historique de commandes RESTE, car les pièces
 * comptables et fiscales doivent être conservées (ARC/Revenu Québec).
 *
 * Concrètement :
 *   - users : PII remplacée par des valeurs neutres, statut ANONYMIZED ;
 *     la ligne est conservée (clé des commandes historiques… sans identité).
 *   - Supprimés : adresses, appareils, jetons de rafraîchissement, paniers,
 *     équipements, plans de rappel, notifications, préférences,
 *     identifications IA (photos = renseignements personnels).
 *   - orders : détachées du compte (user_id nul), adresses figées RÉDUITES à
 *     { ville, province, RTA, pays } — le nécessaire des rapports de taxes —,
 *     courriel/IP/user-agent/notes client effacés. Montants, taxes et lignes
 *     intacts (comptabilité).
 *   - reviews : conservées mais détachées et sans nom d'auteur.
 *   - invoices/shipments : lignes conservées ; les PDF S3 (facture, étiquette)
 *     contiennent l'adresse → leurs clés sont renvoyées pour purge S3 et
 *     effacées des lignes.
 *   - audit_logs : intouchés (append-only) — rétention justifiée par la
 *     prévention de la fraude, durée limitée documentée.
 *
 * L'appelant DOIT purger de S3 les clés renvoyées dans `s3KeysToPurge`.
 */

export interface AnonymizeUserOptions {
  /** Auteur de l'opération (admin ou le client lui-même) pour l'audit. */
  actorType?: 'user' | 'system';
  actorId?: string;
  actorEmail?: string;
  reason?: string;
}

export interface AnonymizeUserResult {
  userId: string;
  anonymizedAt: Date;
  /** Clés S3 à purger (photos IA, étiquettes, PDF de factures). */
  s3KeysToPurge: string[];
  /** Volumes supprimés/détachés, pour le journal de l'opérateur. */
  counts: {
    addresses: number;
    devices: number;
    refreshTokens: number;
    carts: number;
    equipment: number;
    replenishmentPlans: number;
    notifications: number;
    notificationPreferences: number;
    aiIdentifications: number;
    reviewsDetached: number;
    ordersDetached: number;
  };
}

/** Adresse figée d'une commande, réduite au minimum fiscal. */
function redactOrderAddress(address: Prisma.JsonValue | null): Prisma.InputJsonValue {
  const source = (address ?? {}) as Record<string, unknown>;
  const keep = (key: string): string | null =>
    typeof source[key] === 'string' ? (source[key] as string) : null;
  const postalCode = keep('postalCode');
  return {
    anonymized: true,
    city: keep('city'),
    province: keep('province'),
    country: keep('country'),
    // RTA = région de tri d'acheminement (3 premiers caractères) : assez pour
    // les analyses géographiques, pas assez pour identifier une personne.
    postalFsa: postalCode ? postalCode.replace(/\s/g, '').slice(0, 3).toUpperCase() : null,
  };
}

export async function anonymizeUser(
  prisma: PrismaClient,
  userId: string,
  options: AnonymizeUserOptions = {},
): Promise<AnonymizeUserResult> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, status: true, deletionRequestedAt: true },
    });
    if (user.status === 'ANONYMIZED') {
      throw new Error(`Le compte ${userId} est déjà anonymisé.`);
    }

    const anonymizedAt = new Date();
    const s3KeysToPurge: string[] = [];

    // --- Données personnelles associées : collecte des clés S3 puis suppression.
    const aiIdentifications = await tx.aiIdentification.findMany({
      where: { userId },
      select: { imageKey: true, purgedAt: true },
    });
    for (const identification of aiIdentifications) {
      if (!identification.purgedAt) s3KeysToPurge.push(identification.imageKey);
    }

    const counts = {
      addresses: (await tx.address.deleteMany({ where: { userId } })).count,
      devices: (await tx.userDevice.deleteMany({ where: { userId } })).count,
      refreshTokens: (await tx.refreshToken.deleteMany({ where: { userId } })).count,
      carts: (await tx.cart.deleteMany({ where: { userId } })).count,
      // Les plans réfèrent user_equipment (SetNull) : supprimer les plans d'abord.
      replenishmentPlans: (await tx.replenishmentPlan.deleteMany({ where: { userId } })).count,
      equipment: (await tx.userEquipment.deleteMany({ where: { userId } })).count,
      notifications: (await tx.notification.deleteMany({ where: { userId } })).count,
      notificationPreferences: (await tx.notificationPreference.deleteMany({ where: { userId } }))
        .count,
      aiIdentifications: (await tx.aiIdentification.deleteMany({ where: { userId } })).count,
      reviewsDetached: 0,
      ordersDetached: 0,
    };

    // --- Avis : contenu conservé (anonyme), identité coupée.
    counts.reviewsDetached = (
      await tx.review.updateMany({
        where: { userId },
        data: { userId: null, authorName: null },
      })
    ).count;

    // --- Commandes : historique comptable conservé, PII effacée.
    const orders = await tx.order.findMany({
      where: { userId },
      select: { id: true, shippingAddress: true, billingAddress: true },
    });
    for (const order of orders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          userId: null,
          guestEmail: null,
          ipAddress: null,
          userAgent: null,
          customerNote: null,
          shippingAddress: redactOrderAddress(order.shippingAddress),
          billingAddress: redactOrderAddress(order.billingAddress),
        },
      });
    }
    counts.ordersDetached = orders.length;

    const orderIds = orders.map((order) => order.id);
    if (orderIds.length > 0) {
      // PDF de factures et étiquettes d'expédition : contiennent nom/adresse.
      const invoices = await tx.invoice.findMany({
        where: { orderId: { in: orderIds }, pdfKey: { not: null } },
        select: { id: true, pdfKey: true },
      });
      for (const invoice of invoices) {
        if (invoice.pdfKey) s3KeysToPurge.push(invoice.pdfKey);
      }
      await tx.invoice.updateMany({
        where: { orderId: { in: orderIds } },
        data: { pdfKey: null },
      });

      const shipments = await tx.shipment.findMany({
        where: { orderId: { in: orderIds }, labelKey: { not: null } },
        select: { id: true, labelKey: true },
      });
      for (const shipment of shipments) {
        if (shipment.labelKey) s3KeysToPurge.push(shipment.labelKey);
      }
      await tx.shipment.updateMany({
        where: { orderId: { in: orderIds } },
        data: { labelKey: null },
      });
    }

    // --- Le compte lui-même : identité remplacée par des valeurs neutres.
    // Le domaine .invalid (RFC 2606) ne peut recevoir aucun courriel.
    await tx.user.update({
      where: { id: userId },
      data: {
        email: `anonyme+${userId}@compte-supprime.invalid`,
        emailVerifiedAt: null,
        passwordHash: null,
        firstName: null,
        lastName: null,
        phone: null,
        status: 'ANONYMIZED',
        mfaEnabled: false,
        mfaSecretEnc: null,
        mfaRecoveryCodeHashes: [],
        stripeCustomerId: null,
        googleId: null,
        appleId: null,
        lastLoginAt: null,
        anonymizedAt,
        deletionRequestedAt: user.deletionRequestedAt ?? anonymizedAt,
      },
    });

    // --- Trace d'audit (sans PII : l'identité vient d'être effacée).
    await tx.auditLog.create({
      data: {
        actorType: options.actorType ?? 'user',
        actorId: options.actorId ?? userId,
        actorEmail: options.actorEmail ?? null,
        action: 'user.anonymize',
        entityType: 'user',
        entityId: userId,
        metadata: {
          reason: options.reason ?? null,
          counts,
          s3KeysToPurge: s3KeysToPurge.length,
        },
      },
    });

    return { userId, anonymizedAt, s3KeysToPurge, counts };
  });
}
