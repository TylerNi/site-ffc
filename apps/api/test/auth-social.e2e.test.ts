import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  fakeIdToken,
  FakeOidcVerifier,
  lastMail,
  login,
  registerAndVerify,
  TEST_PASSWORD,
  tokenFromMail,
  totpCode,
  uniqueEmail,
} from './auth-helpers';

/**
 * Connexions sociales OIDC (tâche 05). Les vérificateurs Google/Apple sont
 * substitués par FakeOidcVerifier : on teste la LOGIQUE de compte (création,
 * liaison au courriel vérifié, MFA), pas la crypto de jose.
 */
describe('auth — connexions sociales Google/Apple', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      verifiers: [new FakeOidcVerifier('google'), new FakeOidcVerifier('apple')],
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('crée un compte à la première connexion Google (courriel attesté par le fournisseur)', async () => {
    const email = uniqueEmail('google-neuf');
    const response = await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({
        idToken: fakeIdToken({
          subject: 'google-sub-001',
          email,
          emailVerified: true,
          givenName: 'Chantal',
          familyName: 'Bergeron',
        }),
        locale: 'fr',
      })
      .expect(200);
    expect(response.body.mfaRequired).toBe(false);
    expect(response.body.user.email).toBe(email);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.googleId).toBe('google-sub-001');
    expect(user.emailVerifiedAt).not.toBeNull(); // attesté par Google
    expect(user.passwordHash).toBeNull();
    expect(user.firstName).toBe('Chantal');

    // Reconnexion : retrouve le compte par l'id fournisseur.
    const again = await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'google-sub-001', email, emailVerified: true }) })
      .expect(200);
    expect(again.body.user.id).toBe(user.id);
  });

  it('lie Google à un compte courriel existant si l’adresse est vérifiée des DEUX côtés', async () => {
    const email = uniqueEmail('liaison');
    await registerAndVerify(ctx, email); // compte local vérifié

    const response = await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'google-sub-lie', email, emailVerified: true }) })
      .expect(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(response.body.user.id).toBe(user.id);
    expect(user.googleId).toBe('google-sub-lie');
    expect(user.passwordHash).not.toBeNull(); // le mot de passe reste utilisable

    const linkEvents = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.social.linked', actorId: user.id },
    });
    expect(linkEvents).toHaveLength(1);
  });

  it('refuse la liaison automatique si le compte local n’a JAMAIS vérifié son courriel', async () => {
    const email = uniqueEmail('non-verifie');
    await ctx.http().post('/v1/auth/register').send({ email, password: TEST_PASSWORD }).expect(201);
    // (pas de vérification du courriel ici)

    await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'google-sub-capture', email, emailVerified: true }) })
      .expect(409);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.googleId).toBeNull(); // rien n'a été lié
  });

  it('refuse un courriel non attesté par le fournisseur (pas de compte, pas de liaison)', async () => {
    const email = uniqueEmail('atteste-pas');
    await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'google-sub-flou', email, emailVerified: false }) })
      .expect(401);
    expect(await ctx.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('refuse un ID token invalide', async () => {
    await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'x', fail: true }) })
      .expect(401);
  });

  it('fonctionne aussi avec Apple (conformité iOS) et respecte la MFA au login social', async () => {
    // Compte Apple créé, puis MFA activée.
    const email = uniqueEmail('apple');
    const first = await ctx
      .http()
      .post('/v1/auth/social/apple')
      .send({
        idToken: fakeIdToken({ subject: 'apple-sub-001', email, emailVerified: true }),
        firstName: 'Jean', // Apple ne transmet le nom qu'à la 1re connexion, côté client
        lastName: 'Talon',
        locale: 'fr',
      })
      .expect(200);
    const accessToken = first.body.accessToken as string;
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.appleId).toBe('apple-sub-001');
    expect(user.firstName).toBe('Jean');

    const enrolled = await ctx
      .http()
      .post('/v1/auth/mfa/enroll')
      .set('Authorization', bearer(accessToken))
      .expect(200);
    const secret = enrolled.body.secretBase32 as string;
    await ctx
      .http()
      .post('/v1/auth/mfa/activate')
      .set('Authorization', bearer(accessToken))
      .send({ code: totpCode(secret) })
      .expect(200);

    // Nouvelle connexion Apple → défi MFA exigé, comme au login mot de passe.
    const step1 = await ctx
      .http()
      .post('/v1/auth/social/apple')
      .send({ idToken: fakeIdToken({ subject: 'apple-sub-001', email, emailVerified: true }) })
      .expect(200);
    expect(step1.body.mfaRequired).toBe(true);
    const step2 = await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.body.challengeToken, code: totpCode(secret, 1) })
      .expect(200);
    expect(step2.body.user.id).toBe(user.id);
  });

  it('un compte social peut définir un mot de passe via la réinitialisation courriel', async () => {
    const email = uniqueEmail('social-mdp');
    await ctx
      .http()
      .post('/v1/auth/social/google')
      .send({ idToken: fakeIdToken({ subject: 'google-sub-mdp', email, emailVerified: true }) })
      .expect(200);

    // Pas de mot de passe → le login classique échoue neutrement.
    await ctx.http().post('/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);

    // Réinitialisation = preuve du courriel → définit un mot de passe.
    await ctx.http().post('/v1/auth/forgot-password').send({ email }).expect(202);
    const resetToken = tokenFromMail(lastMail(ctx, email, 'password_reset'), 'resetUrl');
    await ctx
      .http()
      .post('/v1/auth/reset-password')
      .send({ token: resetToken, newPassword: TEST_PASSWORD })
      .expect(200);
    await login(ctx, email, TEST_PASSWORD);
  });

  it('501 si le fournisseur n’est pas configuré sur le déploiement', async () => {
    const bare = await createTestApp({ verifiers: [] });
    try {
      await bare
        .http()
        .post('/v1/auth/social/google')
        .send({ idToken: fakeIdToken({ subject: 's', email: 'x@y.z', emailVerified: true }) })
        .expect(501);
    } finally {
      await bare.close();
    }
  });

  it('chaque fournisseur est indépendant : Google configuré n’ouvre pas Apple', async () => {
    const bare = await createTestApp({ verifiers: [new FakeOidcVerifier('google')] });
    try {
      await bare
        .http()
        .post('/v1/auth/social/apple')
        .send({ idToken: fakeIdToken({ subject: 's', email: 'x@y.z', emailVerified: true }) })
        .expect(501);
    } finally {
      await bare.close();
    }
  });
});
