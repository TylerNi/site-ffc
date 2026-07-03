import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from './helpers';

/**
 * Idempotence des webhooks : l'unicité (source, external_id) garantit qu'un
 * événement livré deux fois (retry Stripe/ShipStation) n'est enregistré
 * qu'une seule fois.
 */
describe('webhook_events — unicité (source, external_id)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejette un doublon (même source, même external_id) avec P2002', async () => {
    await prisma.webhookEvent.create({
      data: {
        source: 'stripe',
        externalId: 'evt_test_doublon_001',
        type: 'payment_intent.succeeded',
        payload: { object: 'event' },
      },
    });

    await expect(
      prisma.webhookEvent.create({
        data: {
          source: 'stripe',
          externalId: 'evt_test_doublon_001',
          type: 'payment_intent.succeeded',
          payload: { object: 'event', retry: true },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
      'attendu : violation de contrainte unique (P2002)',
    );
  });

  it('accepte le même external_id venant d’une autre source', async () => {
    const event = await prisma.webhookEvent.create({
      data: {
        source: 'shipstation',
        externalId: 'evt_test_doublon_001',
        type: 'SHIP_NOTIFY',
        payload: {},
      },
    });
    expect(event.id).toBeTruthy();
  });
});
