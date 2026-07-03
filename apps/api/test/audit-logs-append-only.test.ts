import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from './helpers';

/** Le journal d'audit n'accepte que des insertions (trigger SQL). */
describe('audit_logs — append-only', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('accepte l’insertion, refuse UPDATE et DELETE', async () => {
    const log = await prisma.auditLog.create({
      data: {
        actorType: 'system',
        action: 'test.append_only',
        entityType: 'test',
        entityId: 'append-only-1',
        metadata: { source: 'vitest' },
      },
    });

    await expect(
      prisma.auditLog.update({
        where: { id: log.id },
        data: { action: 'test.trafique' },
      }),
    ).rejects.toThrow(/append-only/i);

    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/i);

    // Même un UPDATE/DELETE en SQL brut est bloqué (défense au niveau base).
    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'x' WHERE id = '${log.id}'`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${log.id}'`),
    ).rejects.toThrow(/append-only/i);
  });
});
