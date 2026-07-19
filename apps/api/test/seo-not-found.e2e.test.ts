import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminLogin,
  type AuthTestContext,
  bearer,
  createTestApp,
  makeAdminWithMfa,
} from './auth-helpers';
import {
  NOT_FOUND_PATH_MAX,
  NOT_FOUND_REFERER_MAX,
  SeoNotFoundService,
} from '../src/modules/seo/seo-not-found.service';

const HOST = 'www.vigie-test-e2e.com';
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Vigie SEO post-bascule (tâche 25 §7) : la vitrine signale ses 404 sur un
 * endpoint public agrégé par (hôte, chemin, jour); le rapport quotidien est
 * réservé au personnel disposant de `reports.read`.
 */
describe('seo — vigie des 404 de la vitrine', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.storefrontNotFound.deleteMany({ where: { host: { contains: 'vigie-test' } } });
    await ctx.close();
  });

  it('agrège les signalements par (hôte, chemin, jour) avec compteur et dernier referer', async () => {
    await ctx
      .http()
      .post('/v1/seo/not-found')
      .send({ host: HOST, path: '/vieux-produit/', referer: 'https://google.com/serp' })
      .expect(204);
    await ctx
      .http()
      .post('/v1/seo/not-found')
      .send({ host: HOST.toUpperCase(), path: '/vieux-produit/', referer: 'https://bing.com' })
      .expect(204);
    await ctx.http().post('/v1/seo/not-found').send({ host: HOST, path: '/autre' }).expect(204);

    const rows = await ctx.prisma.storefrontNotFound.findMany({
      where: { host: HOST },
      orderBy: { path: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: '/autre', hits: 1, lastReferer: null });
    expect(rows[1]).toMatchObject({
      path: '/vieux-produit/',
      hits: 2,
      lastReferer: 'https://bing.com',
    });
  });

  it('tronque chemin et referer, refuse un signalement sans chemin', async () => {
    const longPath = `/${'a'.repeat(1200)}`;
    await ctx
      .http()
      .post('/v1/seo/not-found')
      .send({ host: HOST, path: longPath, referer: `https://x.com/${'r'.repeat(900)}` })
      .expect(204);
    const row = await ctx.prisma.storefrontNotFound.findFirstOrThrow({
      where: { host: HOST, path: { startsWith: '/aaa' } },
    });
    expect(row.path).toHaveLength(NOT_FOUND_PATH_MAX);
    expect(row.lastReferer).toHaveLength(NOT_FOUND_REFERER_MAX);

    await ctx.http().post('/v1/seo/not-found').send({ host: HOST }).expect(400);
    await ctx.http().post('/v1/seo/not-found').send({ path: '/x' }).expect(400);
  });

  it('rapport quotidien : top des chemins par hôte, réservé à reports.read', async () => {
    const reporter = await makeAdminWithMfa(ctx, ['catalogue']);
    const token = await adminLogin(
      ctx,
      reporter.email,
      reporter.password,
      reporter.recoveryCodes[0]!,
    );

    const report = await ctx
      .http()
      .get(`/v1/admin/seo/not-found?day=${todayUtc()}&limit=5`)
      .set('Authorization', bearer(token))
      .expect(200);

    expect(report.body.day).toBe(todayUtc());
    const host = (
      report.body.hosts as Array<{
        host: string;
        totalHits: number;
        distinctPaths: number;
        top: Array<{ path: string; hits: number }>;
      }>
    ).find((entry) => entry.host === HOST);
    expect(host).toBeDefined();
    expect(host!.totalHits).toBeGreaterThanOrEqual(4);
    expect(host!.top[0]).toMatchObject({ path: '/vieux-produit/', hits: 2 });
    expect(host!.top.length).toBeLessThanOrEqual(5);
  });

  it('sans permission reports.read : 403; sans session : 401', async () => {
    const noRole = await makeAdminWithMfa(ctx, []);
    const token = await adminLogin(ctx, noRole.email, noRole.password, noRole.recoveryCodes[0]!);
    await ctx.http().get('/v1/admin/seo/not-found').set('Authorization', bearer(token)).expect(403);
    await ctx.http().get('/v1/admin/seo/not-found').expect(401);
  });

  it('purge la rétention passée, garde le reste', async () => {
    const service = ctx.app.get(SeoNotFoundService);
    const old = new Date(Date.now() - 120 * 86_400_000);
    await ctx.prisma.storefrontNotFound.create({
      data: {
        host: 'www.vigie-test-purge.com',
        path: '/tres-vieux',
        day: SeoNotFoundService.dayOf(old),
        hits: 1,
        lastSeenAt: old,
      },
    });
    const purged = await service.purgeOldEntries();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.prisma.storefrontNotFound.count({ where: { host: 'www.vigie-test-purge.com' } }),
    ).toBe(0);
    expect(await ctx.prisma.storefrontNotFound.count({ where: { host: HOST } })).toBeGreaterThan(0);
  });
});
