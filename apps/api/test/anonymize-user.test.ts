import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymizeUser } from '../src/database/anonymize-user';
import { allocateOrderNumber } from '../src/database/order-number';
import { createTestClient } from './helpers';

/**
 * Loi 25 — anonymisation de compte : les données personnelles disparaissent,
 * l'historique de commandes (comptabilité) reste.
 */
describe('anonymisation de compte (Loi 25)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('efface la PII, garde la commande, liste les clés S3 à purger', async () => {
    const variant = await prisma.productVariant.findFirstOrThrow();

    // Compte de test complet : adresse, panier, avis, commande avec facture
    // PDF et expédition étiquetée.
    const user = await prisma.user.create({
      data: {
        email: `a.supprimer.${Date.now()}@example.com`,
        firstName: 'Jean',
        lastName: 'Lapointe',
        phone: '+15145550199',
        passwordHash: 'hash-factice',
        addresses: {
          create: {
            line1: '99, rue de la Confidentialité',
            city: 'Québec',
            province: 'QC',
            postalCode: 'G1R 4S9',
          },
        },
        carts: { create: { status: 'ACTIVE' } },
      },
    });

    const order = await prisma.$transaction(async (tx) => {
      const number = await allocateOrderNumber(tx);
      return tx.order.create({
        data: {
          number,
          userId: user.id,
          status: 'DELIVERED',
          subtotalCents: 2999,
          totalCents: 3448,
          shippingAddress: {
            firstName: 'Jean',
            lastName: 'Lapointe',
            line1: '99, rue de la Confidentialité',
            city: 'Québec',
            province: 'QC',
            postalCode: 'G1R 4S9',
            country: 'CA',
          },
          ipAddress: '203.0.113.7',
          customerNote: 'Sonnez au 99.',
          items: {
            create: {
              variantId: variant.id,
              sku: variant.sku,
              nameFr: 'Filtre test FR',
              nameEn: 'Test filter EN',
              quantity: 1,
              unitPriceCents: 2999,
              subtotalCents: 2999,
              taxCents: 449,
              totalCents: 3448,
            },
          },
          invoices: {
            create: {
              series: 'TEST-ANON-2099',
              sequence: 999,
              number: 'TEST-ANON-2099-000999',
              subtotalCents: 2999,
              totalCents: 3448,
              pdfKey: 'invoices/test-anon-999.pdf',
            },
          },
          shipments: {
            create: {
              carrier: 'CANADA_POST',
              trackingNumber: 'CPANON0001CA',
              status: 'DELIVERED',
              labelKey: 'labels/test-anon-999.pdf',
            },
          },
        },
        include: { items: true },
      });
    });

    const review = await prisma.review.create({
      data: {
        productId: variant.productId,
        userId: user.id,
        orderItemId: order.items[0]!.id,
        orderId: order.id,
        rating: 4,
        body: 'Très bon produit.',
        authorName: 'Jean L.',
        isVerifiedPurchase: true,
        status: 'APPROVED',
      },
    });

    const result = await anonymizeUser(prisma, user.id, {
      actorType: 'system',
      reason: 'test automatisé',
    });

    // Le compte : identité neutralisée, statut ANONYMIZED, ligne conservée.
    const anonymized = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(anonymized.status).toBe('ANONYMIZED');
    expect(anonymized.email).toContain('@compte-supprime.invalid');
    expect(anonymized.firstName).toBeNull();
    expect(anonymized.lastName).toBeNull();
    expect(anonymized.phone).toBeNull();
    expect(anonymized.passwordHash).toBeNull();
    expect(anonymized.anonymizedAt).not.toBeNull();

    // Données personnelles associées : supprimées.
    expect(await prisma.address.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.cart.count({ where: { userId: user.id } })).toBe(0);

    // La commande : conservée pour la comptabilité, mais détachée et expurgée.
    const keptOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(keptOrder.userId).toBeNull();
    expect(keptOrder.totalCents).toBe(3448); // montants intacts
    expect(keptOrder.ipAddress).toBeNull();
    expect(keptOrder.customerNote).toBeNull();
    const address = keptOrder.shippingAddress as Record<string, unknown>;
    expect(address.anonymized).toBe(true);
    expect(address.city).toBe('Québec');
    expect(address.postalFsa).toBe('G1R');
    expect(JSON.stringify(address)).not.toContain('Lapointe');
    expect(JSON.stringify(address)).not.toContain('Confidentialité');

    // Les lignes de commande (immuables) sont toujours là.
    expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1);

    // L'avis : conservé mais anonyme.
    const keptReview = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(keptReview.userId).toBeNull();
    expect(keptReview.authorName).toBeNull();
    expect(keptReview.body).toBe('Très bon produit.');

    // PDF de facture et étiquette : à purger de S3, clés effacées en base.
    expect(result.s3KeysToPurge).toContain('invoices/test-anon-999.pdf');
    expect(result.s3KeysToPurge).toContain('labels/test-anon-999.pdf');
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { orderId: order.id } });
    expect(invoice.pdfKey).toBeNull();
    expect(invoice.totalCents).toBe(3448);

    // Trace d'audit de l'opération.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.anonymize', entityId: user.id },
    });
    expect(audit).not.toBeNull();

    // Une seconde anonymisation est refusée.
    await expect(anonymizeUser(prisma, user.id)).rejects.toThrow(/déjà anonymisé/);
  });
});
