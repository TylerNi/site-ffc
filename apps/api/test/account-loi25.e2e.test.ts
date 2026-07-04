import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  lastMail,
  login,
  registerAndVerify,
  TEST_PASSWORD,
  tokenFromMail,
  uniqueEmail,
} from './auth-helpers';

/**
 * Droits Loi 25 (tâche 05) : export des renseignements personnels et
 * suppression de compte avec confirmation forte (session + jeton courriel),
 * déclenchant l'anonymisation de la tâche 04.
 */
describe('compte — export et suppression Loi 25', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('exporte les renseignements personnels en JSON et consigne l’accès', async () => {
    const email = uniqueEmail('export');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    // Quelques données personnelles à retrouver dans l'export.
    await ctx.prisma.address.create({
      data: {
        userId: user.id,
        line1: '123 rue des Érables',
        city: 'Montréal',
        province: 'QC',
        postalCode: 'H2X 1Y6',
      },
    });

    const response = await ctx
      .http()
      .get('/v1/me/export')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);
    expect(response.headers['content-disposition']).toContain('attachment');

    const exported = response.body as Record<string, unknown>;
    expect(exported.format).toBe('ffc-export-v1');
    expect((exported.profile as { email: string }).email).toBe(email);
    expect(exported.addresses).toHaveLength(1);
    expect((exported.addresses as Array<{ city: string }>)[0]!.city).toBe('Montréal');
    for (const section of [
      'orders',
      'equipment',
      'reviews',
      'notificationPreferences',
      'sessions',
      'devices',
      'aiIdentifications',
      'replenishmentPlans',
      'notifications',
      'couponRedemptions',
    ]) {
      expect(exported).toHaveProperty(section);
    }
    // Aucun secret dans l'export.
    const raw = JSON.stringify(exported);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('mfaSecretEnc');

    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'user.export', actorId: user.id },
    });
    expect(audits).toHaveLength(1);
  });

  it('supprime le compte en deux temps : demande → courriel → confirmation → anonymisation', async () => {
    const email = uniqueEmail('suppression');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const otherDevice = await login(ctx, email);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });

    // Étape 1 : demande — rien n'est supprimé.
    await ctx
      .http()
      .post('/v1/me/deletion-request')
      .set('Authorization', bearer(session.accessToken))
      .expect(202);
    const stillThere = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillThere.status).toBe('ACTIVE');
    expect(stillThere.deletionRequestedAt).not.toBeNull();

    // Un jeton erroné est refusé.
    await ctx
      .http()
      .post('/v1/me/deletion-confirm')
      .set('Authorization', bearer(session.accessToken))
      .send({ token: 'jeton-invente' })
      .expect(400);

    // Étape 2 : confirmation avec le jeton reçu par courriel.
    const confirmToken = tokenFromMail(
      lastMail(ctx, email, 'account_deletion_request'),
      'confirmUrl',
    );
    await ctx
      .http()
      .post('/v1/me/deletion-confirm')
      .set('Authorization', bearer(session.accessToken))
      .send({ token: confirmToken })
      .expect(200);

    // Le compte est ANONYMISÉ : identité effacée, ligne conservée.
    const anonymized = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(anonymized.status).toBe('ANONYMIZED');
    expect(anonymized.email).not.toBe(email);
    expect(anonymized.email).toContain('.invalid');
    expect(anonymized.passwordHash).toBeNull();
    expect(anonymized.anonymizedAt).not.toBeNull();

    // Toutes les sessions sont mortes (refresh ET access).
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: otherDevice.refreshToken })
      .expect(401);
    await ctx
      .http()
      .get('/v1/auth/me')
      .set('Authorization', bearer(session.accessToken))
      .expect(401); // JwtAuthGuard recharge le compte : statut ANONYMIZED → dehors

    // Le courriel d'adieu est parti SANS trace en base (l'adresse est effacée).
    expect(lastMail(ctx, email, 'account_deleted')).toBeDefined();
    const traces = await ctx.prisma.notification.findMany({
      where: { destination: email, templateKey: 'account_deleted' },
    });
    expect(traces).toHaveLength(0);

    // Se reconnecter avec l'ancien courriel échoue neutrement.
    await ctx.http().post('/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);

    // Chaîne d'audit complète.
    const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: user.id } })).map(
      (log) => log.action,
    );
    expect(actions).toContain('user.deletion_requested');
    expect(actions).toContain('user.deletion_confirmed');
    expect(actions).toContain('user.anonymize');
  });

  it('le jeton de suppression d’un compte ne fonctionne pas pour un autre', async () => {
    const emailA = uniqueEmail('suppr-a');
    const emailB = uniqueEmail('suppr-b');
    await registerAndVerify(ctx, emailA);
    await registerAndVerify(ctx, emailB);
    const sessionA = await login(ctx, emailA);
    const sessionB = await login(ctx, emailB);

    await ctx
      .http()
      .post('/v1/me/deletion-request')
      .set('Authorization', bearer(sessionA.accessToken))
      .expect(202);
    const tokenA = tokenFromMail(lastMail(ctx, emailA, 'account_deletion_request'), 'confirmUrl');

    // B présente le jeton de A : refus, personne n'est supprimé.
    await ctx
      .http()
      .post('/v1/me/deletion-confirm')
      .set('Authorization', bearer(sessionB.accessToken))
      .send({ token: tokenA })
      .expect(400);
    const userA = await ctx.prisma.user.findUniqueOrThrow({ where: { email: emailA } });
    const userB = await ctx.prisma.user.findUniqueOrThrow({ where: { email: emailB } });
    expect(userA.status).toBe('ACTIVE');
    expect(userB.status).toBe('ACTIVE');
  });

  it('les endpoints Loi 25 exigent une session valide', async () => {
    await ctx.http().get('/v1/me/export').expect(401);
    await ctx.http().post('/v1/me/deletion-request').expect(401);
    await ctx.http().post('/v1/me/deletion-confirm').send({ token: 'x' }).expect(401);
  });
});
