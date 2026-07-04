import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  createTestApp,
  login,
  registerAndVerify,
  uniqueEmail,
} from './auth-helpers';

/**
 * Rotation des refresh tokens et détection de réutilisation — le cœur du
 * modèle de session de la tâche 05 (critère d'acceptation : une
 * réutilisation révoque la famille entière).
 */
describe('auth — rotation des refresh tokens', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('fait tourner le jeton : l’ancien est marqué usé, le nouveau fonctionne', async () => {
    const email = uniqueEmail('rotation');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    const rotated = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(rotated.body.refreshToken).not.toBe(session.refreshToken);

    // En base : 2 jetons de la même famille, l'ancien usé, le nouveau vivant.
    const rows = await ctx.prisma.refreshToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.familyId).toBe(rows[1]!.familyId);
    expect(rows[0]!.usedAt).not.toBeNull();
    expect(rows[1]!.usedAt).toBeNull();
    // Jamais de jeton en clair en base (le brut est en base64url de 43 caractères).
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Le nouveau jeton continue la session.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(200);
  });

  it('CRITÈRE : la réutilisation d’un jeton usé révoque TOUTE la famille', async () => {
    const email = uniqueEmail('reutilisation');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    // Une autre session (autre appareil) qui doit SURVIVRE à la révocation.
    const otherSession = await login(ctx, email);

    // Rotation légitime…
    const rotated = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);

    // …puis un voleur rejoue l'ANCIEN jeton : refus + famille brûlée.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);

    // Même le successeur légitime est mort (toute la lignée est révoquée).
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);

    // La famille de l'AUTRE session, elle, vit toujours.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: otherSession.refreshToken })
      .expect(200);

    // L'événement de sécurité est audité.
    const reuseEvents = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.refresh.reuse_detected', actorId: user.id },
    });
    expect(reuseEvents.length).toBeGreaterThan(0);

    // Tous les jetons de la famille compromise portent revoked_at.
    const compromised = await ctx.prisma.refreshToken.findMany({
      where: { userId: user.id, familyId: reuseEvents[0]!.entityId! },
    });
    expect(compromised.length).toBeGreaterThan(0);
    expect(compromised.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('refuse un refresh token expiré', async () => {
    const email = uniqueEmail('expire');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    await ctx.prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
  });

  it('refuse un jeton inconnu et une requête sans jeton', async () => {
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'jeton-invente-qui-nexiste-pas' })
      .expect(401);
    await ctx.http().post('/v1/auth/refresh').send({}).expect(401);
  });

  it('liste les sessions actives et permet la révocation individuelle et globale', async () => {
    const email = uniqueEmail('sessions');
    await registerAndVerify(ctx, email);
    const sessionA = await login(ctx, email);
    const sessionB = await login(ctx, email);
    const sessionC = await login(ctx, email);

    // Trois sessions visibles, la courante marquée.
    const list = await ctx
      .http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200);
    expect(list.body).toHaveLength(3);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    // Révocation individuelle de la session B.
    const targetId = (list.body as Array<{ id: string; current: boolean }>).find(
      (s) => !s.current,
    )!.id;
    const revokedOne = await ctx
      .http()
      .delete(`/v1/auth/sessions/${targetId}`)
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200);
    expect(revokedOne.body.revokedSessions).toBe(1);

    // Révocation globale des AUTRES sessions.
    await ctx
      .http()
      .delete('/v1/auth/sessions')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200);

    const remaining = await ctx
      .http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .expect(200);
    expect(remaining.body).toHaveLength(1);
    expect(remaining.body[0].current).toBe(true);

    // La session A (courante) se rafraîchit encore; B et C sont mortes.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: sessionA.refreshToken })
      .expect(200);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: sessionB.refreshToken })
      .expect(401);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: sessionC.refreshToken })
      .expect(401);
  });

  it('une session ne peut pas révoquer les sessions d’un autre compte', async () => {
    const emailA = uniqueEmail('victime');
    const emailB = uniqueEmail('attaquant');
    await registerAndVerify(ctx, emailA);
    await registerAndVerify(ctx, emailB);
    const victim = await login(ctx, emailA);
    const attacker = await login(ctx, emailB);

    const victimSessions = await ctx
      .http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${victim.accessToken}`)
      .expect(200);
    const victimFamilyId = victimSessions.body[0].id as string;

    // L'attaquant vise la famille de la victime : aucune révocation.
    const result = await ctx
      .http()
      .delete(`/v1/auth/sessions/${victimFamilyId}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(200);
    expect(result.body.revokedSessions).toBe(0);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: victim.refreshToken })
      .expect(200);
  });
});
