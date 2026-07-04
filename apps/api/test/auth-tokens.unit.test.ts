import { randomUUID } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaService } from '../src/database';
import {
  decryptSecret,
  encryptSecret,
  generateOpaqueToken,
  generateRecoveryCode,
  sha256Hex,
  timingSafeEqualHex,
} from '../src/modules/auth/crypto.util';
import { OneTimeTokenService } from '../src/modules/auth/one-time-token.service';
import { hashPassword, verifyPassword } from '../src/modules/auth/password';
import { createTestClient } from './helpers';

/**
 * Tests unitaires de la logique des jetons (brief tâche 05) : primitives
 * crypto, paramètres Argon2id, et consommation À USAGE UNIQUE des jetons
 * même sous requêtes concurrentes.
 */
describe('auth — primitives crypto', () => {
  it('les jetons opaques font 256 bits en base64url et se hachent en SHA-256 hex', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(token)).toBe(sha256Hex(token)); // déterministe
  });

  it('chiffre et déchiffre un secret TOTP (AES-256-GCM), refuse une clé altérée', () => {
    const key = Buffer.from('a'.repeat(32), 'utf8').toString('base64');
    const otherKey = Buffer.from('b'.repeat(32), 'utf8').toString('base64');
    const secret = 'JBSWY3DPEHPK3PXP';

    const encrypted = encryptSecret(secret, key);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, key)).toBe(secret);
    // IV aléatoire : deux chiffrements du même secret diffèrent.
    expect(encryptSecret(secret, key)).not.toBe(encrypted);
    // Mauvaise clé ou payload altéré → échec franc (tag GCM).
    expect(() => decryptSecret(encrypted, otherKey)).toThrow();
    const tampered = Buffer.from(encrypted, 'base64');
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decryptSecret(tampered.toString('base64'), key)).toThrow();
  });

  it('les codes de secours sont lisibles et sans caractères ambigus', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('compare des empreintes à temps constant', () => {
    const a = sha256Hex('a');
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, sha256Hex('b'))).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(2))).toBe(false);
  });
});

describe('auth — Argon2id', () => {
  it('produit des hachages Argon2id avec les paramètres documentés (m=64 MiB, t=3, p=1)', async () => {
    const hash = await hashPassword('UnMotDePasse!Long2026');
    expect(hash).toContain('$argon2id$');
    expect(hash).toContain('m=65536,t=3,p=1');
    expect(await verifyPassword(hash, 'UnMotDePasse!Long2026')).toBe(true);
    expect(await verifyPassword(hash, 'MauvaisMotDePasse!26')).toBe(false);
    expect(await verifyPassword('pas-un-hachage', 'peu importe')).toBe(false);
  });
});

describe('auth — jetons à usage unique (concurrence)', () => {
  let prisma: PrismaClient;
  let service: OneTimeTokenService;
  let userId: string;

  beforeAll(async () => {
    prisma = createTestClient({ connectionLimit: 10 });
    service = new OneTimeTokenService(prisma as PrismaService);
    const user = await prisma.user.create({
      data: { email: `jetons-${randomUUID().slice(0, 8)}@test.ffc.local` },
    });
    userId = user.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const ctx = { ip: null, userAgent: null };

  it('un jeton n’est consommable qu’UNE fois, même en parallèle', async () => {
    const { raw } = await service.issue(userId, 'PASSWORD_RESET', ctx);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => service.consume(raw, 'PASSWORD_RESET')),
    );
    const winners = attempts.filter((result) => result !== null);
    expect(winners).toHaveLength(1); // un seul gagnant sous concurrence
    expect(await service.consume(raw, 'PASSWORD_RESET')).toBeNull();
  });

  it('émettre un nouveau jeton invalide le précédent de même finalité', async () => {
    const first = await service.issue(userId, 'EMAIL_VERIFICATION', ctx);
    const second = await service.issue(userId, 'EMAIL_VERIFICATION', ctx);
    expect(await service.consume(first.raw, 'EMAIL_VERIFICATION')).toBeNull();
    expect(await service.consume(second.raw, 'EMAIL_VERIFICATION')).not.toBeNull();
  });

  it('respecte la finalité et l’expiration', async () => {
    const { raw } = await service.issue(userId, 'MFA_CHALLENGE', ctx);
    // Mauvaise finalité → null, et le jeton n'est PAS brûlé.
    expect(await service.consume(raw, 'PASSWORD_RESET')).toBeNull();
    expect(await service.peek(raw, 'MFA_CHALLENGE')).not.toBeNull();

    await prisma.oneTimeToken.updateMany({
      where: { userId, purpose: 'MFA_CHALLENGE' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await service.consume(raw, 'MFA_CHALLENGE')).toBeNull();
  });
});
