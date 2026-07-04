import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  createUserInDb,
  lastMail,
  login,
  registerAndVerify,
  totpCode,
  uniqueEmail,
} from './auth-helpers';

/**
 * MFA TOTP (tâche 05) : enrôlement en deux temps, login à deux facteurs,
 * anti-rejeu, codes de secours à usage unique, MFA imposée aux admins
 * (critère d'acceptation : aucun accès admin sans MFA active).
 */
describe('auth — MFA TOTP', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Enrôle + active la MFA pour un compte connecté; retourne secret et codes. */
  async function enrollMfa(
    accessToken: string,
  ): Promise<{ secret: string; recoveryCodes: string[] }> {
    const enrolled = await ctx
      .http()
      .post('/v1/auth/mfa/enroll')
      .set('Authorization', bearer(accessToken))
      .expect(200);
    const secret = enrolled.body.secretBase32 as string;
    expect(enrolled.body.otpauthUri).toContain('otpauth://totp/');
    expect(enrolled.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const activated = await ctx
      .http()
      .post('/v1/auth/mfa/activate')
      .set('Authorization', bearer(accessToken))
      .send({ code: totpCode(secret) })
      .expect(200);
    const recoveryCodes = activated.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    return { secret, recoveryCodes };
  }

  it('active la MFA puis exige le second facteur au login', async () => {
    const email = uniqueEmail('mfa');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const { secret } = await enrollMfa(session.accessToken!);

    // Secret jamais en clair en base; codes de secours hachés.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.mfaEnabled).toBe(true);
    expect(user.mfaSecretEnc).not.toContain(secret);
    expect(user.mfaRecoveryCodeHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(lastMail(ctx, email, 'mfa_enabled')).toBeDefined();

    // Login : le mot de passe seul ne suffit plus.
    const step1 = await login(ctx, email);
    expect(step1.mfaRequired).toBe(true);
    expect(step1.challengeToken).toBeDefined();
    expect(step1.accessToken).toBeUndefined();

    // Mauvais code → 401, le défi reste utilisable.
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code: '000000' })
      .expect(401);

    // Bon code (pas suivant : celui de l'activation est déjà consommé —
    // anti-rejeu) → session complète.
    const step2 = await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code: totpCode(secret, 1) })
      .expect(200);
    expect(step2.body.accessToken).toBeDefined();

    // Le défi est consommé : il ne sert pas deux fois.
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code: totpCode(secret, 1) })
      .expect(401);

    // Audit : login MFA consigné.
    const successes = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.login.success', actorId: user.id },
    });
    expect(successes.some((log) => (log.metadata as { mfaUsed?: boolean })?.mfaUsed === true)).toBe(
      true,
    );
  });

  it('refuse le rejeu d’un code TOTP déjà consommé dans sa fenêtre', async () => {
    const email = uniqueEmail('rejeu');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const { secret } = await enrollMfa(session.accessToken!);

    const code = totpCode(secret, 1); // pas suivant : accepté (fenêtre ±1), pas encore vu
    const step1 = await login(ctx, email);
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code })
      .expect(200);

    // Rejeu du MÊME code sur un nouveau défi → refusé (pas déjà consommé).
    const step2 = await login(ctx, email);
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step2.challengeToken, code })
      .expect(401);
  });

  it('accepte un code de secours UNE seule fois', async () => {
    const email = uniqueEmail('secours');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const { recoveryCodes } = await enrollMfa(session.accessToken!);
    const recoveryCode = recoveryCodes[0]!;

    const step1 = await login(ctx, email);
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code: recoveryCode })
      .expect(200);

    // Le code est consommé définitivement.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.mfaRecoveryCodeHashes).toHaveLength(9);
    const step2 = await login(ctx, email);
    await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step2.challengeToken, code: recoveryCode })
      .expect(401);

    // Usage du code de secours audité.
    const events = await ctx.prisma.auditLog.findMany({
      where: { action: 'auth.mfa.recovery_code_used', actorId: user.id },
    });
    expect(events).toHaveLength(1);
  });

  it('un client peut désactiver sa MFA avec un code valide', async () => {
    const email = uniqueEmail('desactive');
    await registerAndVerify(ctx, email);
    const session = await login(ctx, email);
    const { secret } = await enrollMfa(session.accessToken!);

    // Mauvais code → refus.
    await ctx
      .http()
      .post('/v1/auth/mfa/disable')
      .set('Authorization', bearer(session.accessToken))
      .send({ code: '000000' })
      .expect(400);

    // Bon code (pas suivant, jamais consommé) → désactivée + notification.
    await ctx
      .http()
      .post('/v1/auth/mfa/disable')
      .set('Authorization', bearer(session.accessToken))
      .send({ code: totpCode(secret, 1) })
      .expect(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecretEnc).toBeNull();
    expect(user.mfaRecoveryCodeHashes).toHaveLength(0);
    expect(lastMail(ctx, email, 'mfa_disabled')).toBeDefined();
  });

  it('CRITÈRE : un admin sans MFA ne peut atteindre AUCUNE route admin', async () => {
    const { user, email, password } = await createUserInDb(ctx, {
      email: uniqueEmail('admin'),
      role: 'ADMIN',
    });
    const session = await login(ctx, email, password);
    expect(session.mfaRequired).toBe(false); // MFA pas encore enrôlée

    // Route admin refusée (403) tant que la MFA n'est pas active.
    const denied = await ctx
      .http()
      .get('/v1/admin/ping')
      .set('Authorization', bearer(session.accessToken))
      .expect(403);
    expect(denied.body.message).toContain('MFA obligatoire');

    // Un simple client reste lui aussi dehors (403), MFA ou pas.
    const customerEmail = uniqueEmail('client');
    await registerAndVerify(ctx, customerEmail);
    const customer = await login(ctx, customerEmail);
    await ctx
      .http()
      .get('/v1/admin/ping')
      .set('Authorization', bearer(customer.accessToken))
      .expect(403);

    // L'admin active sa MFA (routes /auth/mfa accessibles sans MFA, exprès).
    const { secret } = await enrollMfa(session.accessToken!);

    // Reconnexion avec second facteur → la route admin s'ouvre.
    const step1 = await login(ctx, email, password);
    expect(step1.mfaRequired).toBe(true);
    const step2 = await ctx
      .http()
      .post('/v1/auth/login/mfa')
      .send({ challengeToken: step1.challengeToken, code: totpCode(secret, 1) })
      .expect(200);
    const allowed = await ctx
      .http()
      .get('/v1/admin/ping')
      .set('Authorization', bearer(step2.body.accessToken))
      .expect(200);
    expect(allowed.body).toEqual({ status: 'ok', role: 'ADMIN' });

    // Et il ne peut PAS désactiver sa MFA (imposée par le serveur).
    await ctx
      .http()
      .post('/v1/auth/mfa/disable')
      .set('Authorization', bearer(step2.body.accessToken))
      .send({ code: totpCode(secret, 1) })
      .expect(403);
    const refreshedAdmin = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshedAdmin.mfaEnabled).toBe(true);
  });

  it('routes admin inaccessibles sans jeton du tout', async () => {
    await ctx.http().get('/v1/admin/ping').expect(401);
  });
});
