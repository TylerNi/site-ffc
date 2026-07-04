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
 * Parcours courriel de bout en bout (critère d'acceptation tâche 05) :
 * inscription → vérification → connexion → refresh → déconnexion,
 * réinitialisation de mot de passe, changement de mot de passe,
 * neutralité des réponses (anti-énumération).
 */
describe('auth — parcours courriel', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('déroule inscription → vérification → connexion → refresh → déconnexion', async () => {
    const email = uniqueEmail('parcours');

    // Inscription : 201 neutre, PAS de session, courriel de vérification.
    const registered = await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email, password: TEST_PASSWORD, firstName: 'Marie', locale: 'fr' })
      .expect(201);
    expect(registered.body).not.toHaveProperty('accessToken');

    const verifyToken = tokenFromMail(lastMail(ctx, email, 'email_verification'), 'verifyUrl');
    await ctx.http().post('/v1/auth/verify-email').send({ token: verifyToken }).expect(200);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/); // Argon2id, jamais en clair

    // Le même jeton de vérification ne sert pas deux fois.
    await ctx.http().post('/v1/auth/verify-email').send({ token: verifyToken }).expect(400);

    // Connexion : jetons + cookie httpOnly du refresh.
    const loginResponse = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    const session = loginResponse.body as {
      mfaRequired: boolean;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      user: { email: string; emailVerified: boolean };
    };
    expect(session.mfaRequired).toBe(false);
    expect(session.expiresIn).toBe(900); // access token de 15 minutes
    expect(session.user.email).toBe(email);
    const cookies = loginResponse.get('Set-Cookie') ?? [];
    expect(cookies.some((c) => c.startsWith('ffc_refresh=') && c.includes('HttpOnly'))).toBe(true);

    // L'access token ne contient que le nécessaire : sub, role, sid (+ exp/iat/iss/aud).
    const payload = JSON.parse(
      Buffer.from(session.accessToken.split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe('CUSTOMER');
    expect(typeof payload.sid).toBe('string');
    expect(payload).not.toHaveProperty('email');

    // /auth/me avec le Bearer.
    const me = await ctx
      .http()
      .get('/v1/auth/me')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);
    expect(me.body.emailVerified).toBe(true);

    // Refresh : nouveaux jetons.
    const refreshed = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);

    // Déconnexion avec le jeton courant → la session ne se rafraîchit plus.
    await ctx
      .http()
      .post('/v1/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(200);
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(401);
  });

  it('reste neutre : mauvais mot de passe et compte inconnu donnent la même erreur', async () => {
    const email = uniqueEmail('neutre');
    await registerAndVerify(ctx, email);

    const wrongPassword = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email, password: 'MauvaisMotDePasse!99' })
      .expect(401);
    const unknownAccount = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: uniqueEmail('fantome'), password: 'MauvaisMotDePasse!99' })
      .expect(401);
    expect(wrongPassword.body.message).toBe(unknownAccount.body.message);

    // Inscription sur un courriel déjà pris : réponse identique à une
    // inscription fraîche (201 + même message).
    const duplicate = await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const fresh = await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email: uniqueEmail('frais'), password: TEST_PASSWORD })
      .expect(201);
    expect(duplicate.body.message).toBe(fresh.body.message);

    // forgot-password : 202 dans les deux cas.
    await ctx.http().post('/v1/auth/forgot-password').send({ email }).expect(202);
    await ctx
      .http()
      .post('/v1/auth/forgot-password')
      .send({ email: uniqueEmail('fantome') })
      .expect(202);
  });

  it('réinitialise le mot de passe : jeton à usage unique, sessions toutes révoquées', async () => {
    const email = uniqueEmail('reset');
    await registerAndVerify(ctx, email);
    const before = await login(ctx, email);

    await ctx.http().post('/v1/auth/forgot-password').send({ email }).expect(202);
    const resetToken = tokenFromMail(lastMail(ctx, email, 'password_reset'), 'resetUrl');

    const newPassword = 'NouveauMotDePasse!2026';
    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: resetToken, newPassword })
      .expect(200);

    // Toutes les sessions antérieures sont mortes.
    await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: before.refreshToken })
      .expect(401);

    // L'ancien mot de passe ne passe plus; le nouveau oui.
    await ctx.http().post('/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);
    await login(ctx, email, newPassword);

    // Le jeton de réinitialisation est mort (usage unique).
    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: resetToken, newPassword: 'EncoreUnAutre!2026' })
      .expect(400);

    // Courriel « mot de passe modifié » envoyé et tracé sans secret.
    expect(lastMail(ctx, email, 'password_changed')).toBeDefined();
    const traces = await ctx.prisma.notification.findMany({
      where: { destination: email, templateKey: 'password_reset' },
    });
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) {
      expect(JSON.stringify(trace.payload)).not.toContain(resetToken);
    }

    // Audit : demande + réinitialisation consignées.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const auditActions = (await ctx.prisma.auditLog.findMany({ where: { actorId: user.id } })).map(
      (log) => log.action,
    );
    expect(auditActions).toContain('auth.password.reset_requested');
    expect(auditActions).toContain('auth.password.reset');
  });

  it('un jeton de réinitialisation expiré est refusé', async () => {
    const email = uniqueEmail('reset-expire');
    await registerAndVerify(ctx, email);
    await ctx.http().post('/v1/auth/forgot-password').send({ email }).expect(202);
    const resetToken = tokenFromMail(lastMail(ctx, email, 'password_reset'), 'resetUrl');

    // Expiration forcée en base.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    await ctx.prisma.oneTimeToken.updateMany({
      where: { userId: user.id, purpose: 'PASSWORD_RESET' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: resetToken, newPassword: 'PeuImporte!2026x' })
      .expect(400);
  });

  it('change le mot de passe connecté et révoque les AUTRES sessions', async () => {
    const email = uniqueEmail('change');
    await registerAndVerify(ctx, email);
    const sessionA = await login(ctx, email); // session à conserver
    const sessionB = await login(ctx, email); // autre appareil, à révoquer

    const newPassword = 'ChangeConnecte!2026';
    await ctx
      .http()
      .post('/v1/auth/change-password')
      .set('Authorization', bearer(sessionA.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword })
      .expect(200);

    // La session courante survit, l'autre est révoquée.
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

    // Mauvais mot de passe actuel → 400 explicite (l'utilisateur est déjà authentifié).
    const sessionC = await login(ctx, email, newPassword);
    await ctx
      .http()
      .post('/v1/auth/change-password')
      .set('Authorization', bearer(sessionC.accessToken))
      .send({ currentPassword: 'Faux!MotDePasse22', newPassword: 'Autre!MotDePasse22' })
      .expect(400);
  });

  it('notifie une connexion depuis un nouvel appareil (user-agent inédit)', async () => {
    const email = uniqueEmail('appareil');
    await registerAndVerify(ctx, email);

    // 1re connexion (jamais de courriel « nouvel appareil » à la première).
    await ctx
      .http()
      .post('/v1/auth/login')
      .set('User-Agent', 'FFC-Tests/1.0 (appareil-A)')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    expect(lastMail(ctx, email, 'new_device_login')).toBeUndefined();

    // Même appareil → toujours pas de courriel.
    await ctx
      .http()
      .post('/v1/auth/login')
      .set('User-Agent', 'FFC-Tests/1.0 (appareil-A)')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    expect(lastMail(ctx, email, 'new_device_login')).toBeUndefined();

    // Nouvel appareil → notification de sécurité.
    await ctx
      .http()
      .post('/v1/auth/login')
      .set('User-Agent', 'FFC-Tests/1.0 (appareil-B)')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    const notification = lastMail(ctx, email, 'new_device_login');
    expect(notification).toBeDefined();
    expect(notification?.variables.device).toContain('appareil-B');
  });

  it('applique la politique de mot de passe à l’inscription (10 caractères minimum)', async () => {
    await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email: uniqueEmail('court'), password: 'court' })
      .expect(400);
  });
});
