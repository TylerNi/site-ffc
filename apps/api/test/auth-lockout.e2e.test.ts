import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  createTestApp,
  login,
  registerAndVerify,
  TEST_PASSWORD,
  uniqueEmail,
} from './auth-helpers';

/**
 * Anti force brute (tâche 05) : verrouillage progressif PAR COMPTE
 * (en base, persistant) + rate limiting PAR IP (@nestjs/throttler).
 */
describe('auth — verrouillage progressif', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp(); // throttling IP désactivé : on isole le verrouillage
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('verrouille le compte au 5e échec, avec durée progressive', async () => {
    const email = uniqueEmail('bruteforce');
    await registerAndVerify(ctx, email);
    const attempt = (): ReturnType<ReturnType<AuthTestContext['http']>['post']> =>
      ctx.http().post('/v1/auth/login').send({ email, password: 'MauvaisMdp!0000' });

    // 4 premiers échecs : 401 neutre, pas de verrou.
    for (let i = 0; i < 4; i += 1) {
      await attempt().expect(401);
    }
    let user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(4);
    expect(user.lockedUntil).toBeNull();

    // 5e échec : verrou d'une minute.
    await attempt().expect(401);
    user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil).not.toBeNull();
    const firstLockMs = user.lockedUntil!.getTime() - Date.now();
    expect(firstLockMs).toBeGreaterThan(30_000);
    expect(firstLockMs).toBeLessThanOrEqual(60_500);

    // Pendant le verrou, MÊME LE BON mot de passe est refusé (429).
    await ctx.http().post('/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(429);

    // On simule l'expiration du verrou; l'échec suivant DOUBLE la durée.
    await ctx.prisma.user.update({ where: { email }, data: { lockedUntil: new Date() } });
    await attempt().expect(401);
    user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const secondLockMs = user.lockedUntil!.getTime() - Date.now();
    expect(secondLockMs).toBeGreaterThan(90_000); // ~2 minutes
    expect(user.failedLoginCount).toBe(6);

    // Verrou levé + bon mot de passe → connexion ET remise à zéro.
    await ctx.prisma.user.update({ where: { email }, data: { lockedUntil: new Date() } });
    await login(ctx, email);
    user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();

    // Chaque échec est consigné dans audit_logs.
    const failures = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.login.failed', actorId: user.id },
    });
    expect(failures.length).toBeGreaterThanOrEqual(6);
  });

  it('le verrouillage ne révèle pas l’existence du compte (message identique au throttling)', async () => {
    const email = uniqueEmail('discret');
    await registerAndVerify(ctx, email);
    for (let i = 0; i < 5; i += 1) {
      await ctx.http().post('/v1/auth/login').send({ email, password: 'MauvaisMdp!0000' });
    }
    const locked = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(429);
    expect(locked.body.message).toBe('Trop de tentatives. Réessayez plus tard.');
  });
});

describe('auth — rate limiting par IP', () => {
  let throttled: AuthTestContext;

  beforeAll(async () => {
    throttled = await createTestApp({ throttleEnabled: true });
  });
  afterAll(async () => {
    await throttled.close();
  });

  it('coupe les rafales sur /auth/login après 10 requêtes / 15 min / IP', async () => {
    // Emails DIFFÉRENTS et inexistants : seul le rate limiting IP peut bloquer.
    let saw429 = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await throttled
        .http()
        .post('/v1/auth/login')
        .send({ email: uniqueEmail(`rafale-${i}`), password: 'PeuImporte!0000' });
      if (i < 10) {
        expect(response.status).toBe(401);
      } else if (response.status === 429) {
        saw429 = true;
      }
    }
    expect(saw429).toBe(true);
  });
});
