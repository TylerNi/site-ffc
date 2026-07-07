import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthTestContext,
  bearer,
  createTestApp,
  createUserInDb,
  lastMail,
  login,
  tokenFromMail,
  totpCode,
  uniqueEmail,
} from './auth-helpers';

/**
 * Admin — socle et RBAC (tâche 09). Couvre les quatre critères d'acceptation :
 *   1. un compte lecture_seule ne peut ni voir ni appeler une mutation (403);
 *   2. un admin sans MFA active ne peut pas ouvrir de session admin;
 *   3. une action sensible sans step-up est refusée; avec step-up elle passe
 *      et apparaît dans l'audit avec avant/après;
 *   4. invitation → création de compte → attribution de rôle → désactivation.
 */
describe('admin — socle et RBAC', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Enrôle la MFA sur un compte et lui attribue des rôles fins en base. */
  async function makeAdminWithMfa(
    roleKeys: string[],
  ): Promise<{ id: string; email: string; password: string; recoveryCodes: string[] }> {
    const { user, email, password } = await createUserInDb(ctx, {
      email: uniqueEmail('adm'),
      role: 'ADMIN',
    });
    const session = await login(ctx, email, password);
    const enroll = await ctx
      .http()
      .post('/v1/auth/mfa/enroll')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);
    const secret = enroll.body.secretBase32 as string;
    const activated = await ctx
      .http()
      .post('/v1/auth/mfa/activate')
      .set('Authorization', bearer(session.accessToken))
      .send({ code: totpCode(secret) })
      .expect(200);
    await assignRolesInDb(user.id, roleKeys);
    return {
      id: user.id,
      email,
      password,
      recoveryCodes: activated.body.recoveryCodes as string[],
    };
  }

  async function assignRolesInDb(userId: string, roleKeys: string[]): Promise<void> {
    const roles = await ctx.prisma.role.findMany({ where: { key: { in: roleKeys } } });
    expect(roles).toHaveLength(roleKeys.length);
    await ctx.prisma.userRoleAssignment.deleteMany({ where: { userId } });
    await ctx.prisma.userRoleAssignment.createMany({
      data: roles.map((role) => ({ userId, roleId: role.id })),
    });
  }

  /** Connexion admin complète (courriel + mot de passe + second facteur). */
  async function adminLogin(email: string, password: string, code: string): Promise<string> {
    const step1 = await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email, password })
      .expect(200);
    expect(step1.body.challengeToken).toBeDefined();
    const step2 = await ctx
      .http()
      .post('/v1/admin/auth/login/mfa')
      .send({ challengeToken: step1.body.challengeToken, code })
      .expect(200);
    expect(step2.body.accessToken).toBeDefined();
    return step2.body.accessToken as string;
  }

  async function requestStepUp(accessToken: string, code: string): Promise<string> {
    const res = await ctx
      .http()
      .post('/v1/admin/auth/step-up')
      .set('Authorization', bearer(accessToken))
      .send({ code })
      .expect(200);
    return res.body.stepUpToken as string;
  }

  /* --------------------------- Critère 2 : MFA obligatoire ------------------- */

  it('CRITÈRE 2 : un admin sans MFA ne peut pas ouvrir de session admin', async () => {
    const { email, password } = await createUserInDb(ctx, {
      email: uniqueEmail('nomfa'),
      role: 'ADMIN',
    });
    const denied = await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email, password })
      .expect(403);
    expect(denied.body.message).toContain('MFA');

    // Un compte client se voit refuser l'accès admin avec une erreur neutre (401).
    const customerEmail = uniqueEmail('client');
    const { email: cEmail, password: cPassword } = await createUserInDb(ctx, {
      email: customerEmail,
      role: 'CUSTOMER',
    });
    await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email: cEmail, password: cPassword })
      .expect(401);
  });

  /* --------------------------- Critère 1 : RBAC lecture_seule ---------------- */

  it('CRITÈRE 1 : lecture_seule ne peut ni voir ni muter (403 même en forçant)', async () => {
    const reader = await makeAdminWithMfa(['lecture_seule']);
    const token = await adminLogin(reader.email, reader.password, reader.recoveryCodes[0]!);

    // Le profil expose des permissions de lecture seulement (aucune écriture).
    const me = await ctx
      .http()
      .get('/v1/admin/auth/me')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(me.body.roles).toEqual([expect.objectContaining({ key: 'lecture_seule' })]);
    expect(me.body.permissions).toContain('orders.read');
    expect(me.body.permissions).not.toContain('admin_users.write');
    expect(me.body.permissions).not.toContain('admin_users.read');

    // Ne peut PAS voir la liste des comptes du personnel (manque admin_users.read).
    await ctx.http().get('/v1/admin/users').set('Authorization', bearer(token)).expect(403);

    // Ne peut PAS appeler une mutation, même en forgeant la requête (manque
    // admin_users.write) : la garde serveur refuse avant toute logique.
    const forged = await ctx
      .http()
      .patch(`/v1/admin/users/${reader.id}/roles`)
      .set('Authorization', bearer(token))
      .set('x-step-up-token', 'jeton-forgé-invalide')
      .send({ roleKeys: ['super_admin'] })
      .expect(403);
    expect(forged.body.message).toContain('Permission');

    // Le compte n'a effectivement pas été promu.
    const stillReader = await ctx.prisma.userRoleAssignment.findMany({
      where: { userId: reader.id },
      include: { role: true },
    });
    expect(stillReader.map((assignment) => assignment.role.key)).toEqual(['lecture_seule']);
  });

  it('un super_admin, lui, voit et administre', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const token = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);

    const me = await ctx
      .http()
      .get('/v1/admin/auth/me')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(me.body.permissions).toContain('*');

    const listed = await ctx
      .http()
      .get('/v1/admin/users')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(Array.isArray(listed.body)).toBe(true);

    // Le tableau de bord répond avec des tuiles chiffrées.
    const dashboard = await ctx
      .http()
      .get('/v1/admin/dashboard/summary')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(dashboard.body).toMatchObject({ currency: 'CAD' });
    expect(typeof dashboard.body.ordersToShip).toBe('number');
  });

  /* --------------------------- Critère 3 : step-up --------------------------- */

  it('CRITÈRE 3 : action sensible refusée sans step-up, acceptée avec, auditée avant/après', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const token = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);

    // Une cible du personnel à faire évoluer.
    const target = await makeAdminWithMfa(['lecture_seule']);

    // Sans step-up → 403 avec code distinctif.
    const refused = await ctx
      .http()
      .patch(`/v1/admin/users/${target.id}/roles`)
      .set('Authorization', bearer(token))
      .send({ roleKeys: ['commandes'] })
      .expect(403);
    expect(refused.body.code).toBe('STEP_UP_REQUIRED');

    // Avec un step-up récent → accepté.
    const stepUpToken = await requestStepUp(token, admin.recoveryCodes[1]!);
    const updated = await ctx
      .http()
      .patch(`/v1/admin/users/${target.id}/roles`)
      .set('Authorization', bearer(token))
      .set('x-step-up-token', stepUpToken)
      .send({ roleKeys: ['commandes'] })
      .expect(200);
    expect(updated.body.roles).toEqual([expect.objectContaining({ key: 'commandes' })]);

    // Audité avec avant/après.
    const entry = await ctx.prisma.auditLog.findFirst({
      where: { action: 'admin.users.roles_update', entityId: target.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect((entry!.before as { roleKeys: string[] }).roleKeys).toEqual(['lecture_seule']);
    expect((entry!.after as { roleKeys: string[] }).roleKeys).toEqual(['commandes']);
    expect(entry!.actorId).toBe(admin.id);
  });

  it('un jeton de step-up d’une autre session est refusé', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const tokenA = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);
    const stepUp = await requestStepUp(tokenA, admin.recoveryCodes[1]!);

    // Nouvelle session (autre sid) : le step-up de la session A n'est pas valide ici.
    const tokenB = await adminLogin(admin.email, admin.password, admin.recoveryCodes[2]!);
    const target = await makeAdminWithMfa(['lecture_seule']);
    await ctx
      .http()
      .patch(`/v1/admin/users/${target.id}/roles`)
      .set('Authorization', bearer(tokenB))
      .set('x-step-up-token', stepUp)
      .send({ roleKeys: ['commandes'] })
      .expect(403);
  });

  /* --------------------------- Critère 4 : cycle de vie ---------------------- */

  it('CRITÈRE 4 : invitation → acceptation → attribution de rôle → désactivation', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const token = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);
    const stepUpToken = await requestStepUp(token, admin.recoveryCodes[1]!);

    // 1. Invitation.
    const inviteeEmail = uniqueEmail('invite');
    const invited = await ctx
      .http()
      .post('/v1/admin/users/invitations')
      .set('Authorization', bearer(token))
      .set('x-step-up-token', stepUpToken)
      .send({ email: inviteeEmail, roleKeys: ['lecture_seule'], firstName: 'Nadia' })
      .expect(201);
    expect(invited.body.invitedPendingAt).not.toBeNull();
    expect(invited.body.roles).toEqual([expect.objectContaining({ key: 'lecture_seule' })]);
    const inviteeId = invited.body.id as string;

    // Le compte invité ne peut pas encore se connecter (aucun mot de passe).
    await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email: inviteeEmail, password: 'PeuImporte!2026' })
      .expect(401);

    // 2. Acceptation via le jeton reçu par courriel.
    const inviteToken = tokenFromMail(lastMail(ctx, inviteeEmail, 'admin_invitation'), 'acceptUrl');
    await ctx
      .http()
      .post('/v1/admin/invitations/accept')
      .send({ token: inviteToken, password: 'Chauffage!2026-nadia' })
      .expect(200);
    const accepted = await ctx.prisma.user.findUniqueOrThrow({ where: { id: inviteeId } });
    expect(accepted.passwordHash).not.toBeNull();
    expect(accepted.emailVerifiedAt).not.toBeNull();

    // Le jeton d'invitation ne sert qu'une fois.
    await ctx
      .http()
      .post('/v1/admin/invitations/accept')
      .send({ token: inviteToken, password: 'Chauffage!2026-autre' })
      .expect(400);

    // 3. Attribution d'un nouveau rôle.
    const promoted = await ctx
      .http()
      .patch(`/v1/admin/users/${inviteeId}/roles`)
      .set('Authorization', bearer(token))
      .set('x-step-up-token', stepUpToken)
      .send({ roleKeys: ['catalogue'] })
      .expect(200);
    expect(promoted.body.roles).toEqual([expect.objectContaining({ key: 'catalogue' })]);

    // 4. Désactivation immédiate (statut + révocation de sessions).
    const deactivated = await ctx
      .http()
      .post(`/v1/admin/users/${inviteeId}/deactivate`)
      .set('Authorization', bearer(token))
      .set('x-step-up-token', stepUpToken)
      .send({})
      .expect(200);
    expect(deactivated.body.status).toBe('DISABLED');
    const disabled = await ctx.prisma.user.findUniqueOrThrow({ where: { id: inviteeId } });
    expect(disabled.status).toBe('DISABLED');

    // Toute la chaîne d'audit est présente.
    const actions = await ctx.prisma.auditLog.findMany({
      where: { entityId: inviteeId, action: { startsWith: 'admin.users' } },
      select: { action: true },
    });
    const actionSet = new Set(actions.map((row) => row.action));
    expect(actionSet).toContain('admin.users.invited');
    expect(actionSet).toContain('admin.users.invitation_accepted');
    expect(actionSet).toContain('admin.users.roles_update');
    expect(actionSet).toContain('admin.users.deactivated');
  });

  it('la désactivation révoque l’accès immédiatement (compte rechargé à chaque requête)', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const adminToken = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);
    const stepUpToken = await requestStepUp(adminToken, admin.recoveryCodes[1]!);

    const victim = await makeAdminWithMfa(['commandes']);
    const victimToken = await adminLogin(victim.email, victim.password, victim.recoveryCodes[0]!);
    // La session fonctionne...
    await ctx.http().get('/v1/admin/auth/me').set('Authorization', bearer(victimToken)).expect(200);

    // ...jusqu'à la désactivation.
    await ctx
      .http()
      .post(`/v1/admin/users/${victim.id}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .set('x-step-up-token', stepUpToken)
      .send({})
      .expect(200);
    await ctx.http().get('/v1/admin/auth/me').set('Authorization', bearer(victimToken)).expect(401);
  });

  /* --------------------------- Audit : journal en lecture seule -------------- */

  it('le journal d’audit est consultable, filtrable et en lecture seule', async () => {
    const admin = await makeAdminWithMfa(['super_admin']);
    const token = await adminLogin(admin.email, admin.password, admin.recoveryCodes[0]!);

    const page = await ctx
      .http()
      .get('/v1/admin/audit-logs')
      .query({ action: 'admin.login', limit: 5 })
      .set('Authorization', bearer(token))
      .expect(200);
    expect(Array.isArray(page.body.items)).toBe(true);
    expect(
      page.body.items.every((item: { action: string }) => item.action.startsWith('admin.login')),
    ).toBe(true);

    // Aucune route d'écriture n'existe sur le journal.
    await ctx
      .http()
      .post('/v1/admin/audit-logs')
      .set('Authorization', bearer(token))
      .send({})
      .expect(404);
    await ctx
      .http()
      .delete(`/v1/admin/audit-logs/${page.body.items[0]?.id ?? admin.id}`)
      .set('Authorization', bearer(token))
      .expect(404);
  });

  it('routes admin inaccessibles sans jeton', async () => {
    await ctx.http().get('/v1/admin/users').expect(401);
    await ctx.http().get('/v1/admin/dashboard/summary').expect(401);
    await ctx.http().get('/v1/admin/audit-logs').expect(401);
  });
});
