import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createUserInDb, login, totpCode, uniqueEmail } from './auth-helpers';
import { paidOrderForUser } from './order-helpers';
import { createShipstationTestApp, type ShipstationTestContext } from './shipstation-helpers';

/**
 * Vue de resynchronisation ShipStation (tâche 13, travail demandé nº 5) :
 * l'API admin qui liste les commandes en échec avec leur cause et permet de
 * les « repousser ». L'écran complet arrive à la tâche 22.
 *
 * Le RBAC fin de la tâche 09 s'applique : `shipments.read` pour consulter,
 * `shipments.write` pour repousser.
 */
describe('ShipStation — vue de resynchronisation admin (tâche 13)', () => {
  let ctx: ShipstationTestContext;

  beforeAll(async () => {
    ctx = await createShipstationTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Compte du personnel avec MFA active et rôles fins, connecté à l'admin. */
  async function adminWithRoles(roleKeys: string[]): Promise<string> {
    const { user, email, password } = await createUserInDb(ctx, {
      email: uniqueEmail('adm-ss'),
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

    const roles = await ctx.prisma.role.findMany({ where: { key: { in: roleKeys } } });
    expect(roles).toHaveLength(roleKeys.length);
    await ctx.prisma.userRoleAssignment.createMany({
      data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
    });

    // Le code TOTP de l'activation ne peut pas être rejoué (garde anti-rejeu) :
    // la connexion admin utilise un code de secours, comme la suite RBAC.
    const recoveryCode = (activated.body.recoveryCodes as string[])[0]!;
    const step1 = await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email, password })
      .expect(200);
    const step2 = await ctx
      .http()
      .post('/v1/admin/auth/login/mfa')
      .send({ challengeToken: step1.body.challengeToken, code: recoveryCode })
      .expect(200);
    return step2.body.accessToken as string;
  }

  /** Commande payée dont la poussée a échoué définitivement. */
  async function failedOrder(): Promise<{ id: string; number: string }> {
    const paid = await paidOrderForUser(ctx);
    ctx.shipstation.failPermanently();
    await ctx.drain();
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNC_FAILED');
    return { id: paid.order.id, number: paid.order.number };
  }

  it('liste les commandes en échec avec leur cause, et les compte par statut', async () => {
    const order = await failedOrder();
    const token = await adminWithRoles(['commandes']);

    const response = await ctx
      .http()
      .get('/v1/admin/shipstation')
      .set('Authorization', bearer(token))
      .expect(200);

    expect(response.body.configured).toBe(true);
    expect(response.body.counts.SYNC_FAILED).toBeGreaterThanOrEqual(1);

    const item = (response.body.items as Array<Record<string, unknown>>).find(
      (entry) => entry.orderId === order.id,
    );
    expect(item).toBeDefined();
    expect(item!.orderNumber).toBe(order.number);
    expect(item!.status).toBe('SYNC_FAILED');
    expect(item!.operation).toBe('CREATE');
    expect(item!.attempts).toBe(1);
    expect(String(item!.lastError)).toContain('401');
    expect(item!.orderStatus).toBe('PAID');
  });

  it('« repousser » rejoue la poussée et la commande sort de la file', async () => {
    const order = await failedOrder();
    const token = await adminWithRoles(['commandes']);
    ctx.shipstation.clearFailures();

    const response = await ctx
      .http()
      .post(`/v1/admin/shipstation/${order.id}/retry`)
      .set('Authorization', bearer(token))
      .expect(200);

    expect(response.body.status).toBe('SYNCED');
    expect(response.body.attempts).toBe(0);
    expect(response.body.lastError).toBeNull();
    expect(ctx.shipstation.order(order.number)).toBeDefined();

    // La commande a rejoint l'équipe d'expédition.
    const updated = await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe('PROCESSING');

    // L'action est tracée avec son acteur.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: 'shipstation.retry' },
    });
    expect(audit.actorType).toBe('admin');
    expect(audit.actorId).toBeTruthy();
  });

  it('le RBAC s’applique : lecture_seule consulte mais ne peut pas repousser', async () => {
    const order = await failedOrder();
    const token = await adminWithRoles(['lecture_seule']);

    await ctx.http().get('/v1/admin/shipstation').set('Authorization', bearer(token)).expect(200);
    await ctx
      .http()
      .post(`/v1/admin/shipstation/${order.id}/retry`)
      .set('Authorization', bearer(token))
      .expect(403);

    // Rien n'a bougé.
    expect((await ctx.syncRow(order.id)).status).toBe('SYNC_FAILED');
  });

  it('l’endpoint est fermé aux clients et aux anonymes', async () => {
    await ctx.http().get('/v1/admin/shipstation').expect(401);

    const customerEmail = uniqueEmail('client-ss');
    const { email, password } = await createUserInDb(ctx, { email: customerEmail });
    const session = await login(ctx, email, password);
    await ctx
      .http()
      .get('/v1/admin/shipstation')
      .set('Authorization', bearer(session.accessToken))
      .expect(403);
  });

  it('repousser une commande sans ligne de synchronisation répond 404', async () => {
    const token = await adminWithRoles(['commandes']);
    await ctx
      .http()
      .post('/v1/admin/shipstation/019f4716-0000-7000-8000-000000000000/retry')
      .set('Authorization', bearer(token))
      .expect(404);
  });
});
