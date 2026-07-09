import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer } from './auth-helpers';
import { paidOrderForUser } from './order-helpers';
import { createShipstationTestApp, type ShipstationTestContext } from './shipstation-helpers';
import { RefundService } from '../src/modules/orders/refunds/refund.service';
import { SHIPSTATION_MAX_ATTEMPTS } from '../src/modules/shipping/shipstation/shipstation-outbox';

/**
 * Poussée des commandes vers ShipStation (tâche 13) — critères 1 et 3 du brief :
 *
 *   1. commande payée ⇒ présente dans ShipStation, champs complets et corrects ;
 *   3. panne réseau simulée ⇒ retentatives ⇒ succès SANS DOUBLON ; échec
 *      définitif visible dans la file avec « repousser » fonctionnel.
 *
 * Plus les annulations (critère du travail demandé nº 4).
 */
describe('ShipStation — poussée des commandes (tâche 13)', () => {
  let ctx: ShipstationTestContext;

  beforeAll(async () => {
    ctx = await createShipstationTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /* --------------------------- Critère 1 : poussée -------------------------- */

  it('CRITÈRE 1 : la commande payée est mise en file dans SA transaction, puis créée dans ShipStation avec les bons champs', async () => {
    const paid = await paidOrderForUser(ctx, { priceCents: 4_500, quantity: 2, stock: 5 });

    // La ligne d'envoi existe DÈS la finalisation : rien ne peut être oublié.
    const queued = await ctx.syncRow(paid.order.id);
    expect(queued).toMatchObject({ status: 'PENDING', operation: 'CREATE', attempts: 0 });

    const report = await ctx.drain();
    expect(report).toMatchObject({ processed: 1, synced: 1, failed: 0 });

    const synced = await ctx.syncRow(paid.order.id);
    expect(synced.status).toBe('SYNCED');
    expect(synced.shipstationOrderId).toBeTruthy();
    expect(synced.shipstationOrderKey).toBe(paid.order.number);
    expect(synced.nextAttemptAt).toBeNull();

    // Champs vus par l'équipe d'expédition.
    const pushed = ctx.shipstation.order(paid.order.number)!;
    expect(pushed.orderNumber).toBe(paid.order.number);
    expect(pushed.orderKey).toBe(paid.order.number);
    expect(pushed.orderStatus).toBe('awaiting_shipment');
    expect(pushed.customerEmail).toBe(paid.email);
    expect(pushed.advancedOptions.customField1).toBe(paid.order.id);
    expect(pushed.shipTo.state).toBe('QC');
    expect(pushed.amountPaid).toBeCloseTo(paid.order.totalCents / 100, 2);
    expect(pushed.items).toHaveLength(1);
    expect(pushed.items[0]).toMatchObject({ sku: paid.variant.sku, quantity: 2, unitPrice: 45 });
    expect(pushed.weight.units).toBe('grams');
    expect(pushed.weight.value).toBeGreaterThan(0);

    // La commande est passée « en préparation » chez nous.
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('PROCESSING');
  });

  it('un drain rejoué ne recrée rien (la ligne synchronisée n’est plus due)', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx.drain();
    const callsAfterFirst = ctx.shipstation.createCalls;

    const second = await ctx.drain();
    expect(second.processed).toBe(0);
    expect(ctx.shipstation.createCalls).toBe(callsAfterFirst);
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNCED');
  });

  it('une ligne réarmée à la main trouve la commande par référence externe et ne crée pas de doublon', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx.drain();
    const createsBefore = ctx.shipstation.createCalls;
    const ordersBefore = ctx.shipstation.orderCount();

    await ctx.prisma.shipstationSync.update({
      where: { orderId: paid.order.id },
      data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    await ctx.drain();

    // Aucune création : la recherche par orderNumber a trouvé la commande.
    expect(ctx.shipstation.createCalls).toBe(createsBefore);
    expect(ctx.shipstation.orderCount()).toBe(ordersBefore);
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNCED');
  });

  /* ----------------------- Critère 3 : pannes et retries -------------------- */

  it('CRITÈRE 3 : panne réseau après création côté ShipStation ⇒ retentative ⇒ succès sans doublon', async () => {
    const paid = await paidOrderForUser(ctx);
    const ordersBefore = ctx.shipstation.orderCount();

    // Le cas vicieux : ShipStation crée la commande, la réponse se perd.
    ctx.shipstation.failCreateAfterPersist(1);
    const first = await ctx.drain();
    expect(first).toMatchObject({ retried: 1, synced: 0 });

    const afterFailure = await ctx.syncRow(paid.order.id);
    expect(afterFailure.status).toBe('PENDING');
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.lastError).toContain('Délai dépassé');
    // La retentative est PLANIFIÉE dans le futur (recul exponentiel).
    expect(afterFailure.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    await ctx.makeDue(paid.order.id);
    const second = await ctx.drain();
    expect(second).toMatchObject({ synced: 1 });

    const synced = await ctx.syncRow(paid.order.id);
    expect(synced.status).toBe('SYNCED');
    expect(synced.attempts).toBe(0);
    expect(synced.lastError).toBeNull();
    // UNE seule commande dans ShipStation : aucun doublon.
    expect(ctx.shipstation.orderCount()).toBe(ordersBefore + 1);
  });

  it('CRITÈRE 3 : après épuisement des tentatives, la commande tombe dans la file d’échec avec sa cause', async () => {
    const paid = await paidOrderForUser(ctx);
    ctx.shipstation.failNetwork(SHIPSTATION_MAX_ATTEMPTS);

    for (let attempt = 1; attempt <= SHIPSTATION_MAX_ATTEMPTS; attempt += 1) {
      await ctx.makeDue(paid.order.id);
      await ctx.drain();
    }

    const failed = await ctx.syncRow(paid.order.id);
    expect(failed.status).toBe('SYNC_FAILED');
    expect(failed.attempts).toBe(SHIPSTATION_MAX_ATTEMPTS);
    expect(failed.lastError).toContain('ECONNRESET');
    expect(failed.nextAttemptAt).toBeNull();
    // La commande reste PAYÉE : elle n'a jamais atteint l'équipe d'expédition.
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('PAID');

    // Une erreur définitive (4xx) ne consomme pas cinq tentatives.
    const other = await paidOrderForUser(ctx);
    ctx.shipstation.failPermanently();
    await ctx.drain();
    const rejected = await ctx.syncRow(other.order.id);
    expect(rejected.status).toBe('SYNC_FAILED');
    expect(rejected.attempts).toBe(1);
  });

  it('« repousser » rejoue l’opération et sort la commande de la file d’échec', async () => {
    const paid = await paidOrderForUser(ctx);
    ctx.shipstation.failPermanently();
    await ctx.drain();
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNC_FAILED');

    ctx.shipstation.clearFailures();
    const retried = await ctx.sync.retry(paid.order.id, { type: 'admin', userId: null });
    expect(retried.status).toBe('SYNCED');
    expect(ctx.shipstation.order(paid.order.number)).toBeDefined();

    const audit = await ctx.prisma.auditLog.findMany({
      where: {
        entityId: paid.order.id,
        action: { in: ['shipstation.retry', 'shipstation.sync_failed'] },
      },
    });
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'shipstation.retry',
      'shipstation.sync_failed',
    ]);
  });

  it('sans clés ShipStation, les commandes attendent en file sans consommer de tentative', async () => {
    const paid = await paidOrderForUser(ctx);
    ctx.shipstation.setConfigured(false);
    try {
      const report = await ctx.drain();
      expect(report.processed).toBe(0);
      const row = await ctx.syncRow(paid.order.id);
      expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
    } finally {
      ctx.shipstation.setConfigured(true);
    }
  });

  /* ------------------------------ Annulations ------------------------------- */

  it('une commande annulée avant l’étiquette est annulée dans ShipStation', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx.drain();
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNCED');

    await ctx
      .http()
      .post(`/v1/me/orders/${paid.order.id}/cancel`)
      .set('Authorization', bearer(paid.accessToken))
      .expect(200);

    // L'annulation est mise en file, puis poussée par le drain.
    const queued = await ctx.syncRow(paid.order.id);
    expect(queued).toMatchObject({ status: 'PENDING', operation: 'CANCEL' });

    await ctx.drain();
    expect((await ctx.syncRow(paid.order.id)).status).toBe('CANCELLED');
    expect(ctx.shipstation.order(paid.order.number)!.orderStatus).toBe('cancelled');
  });

  it('une commande annulée AVANT toute poussée n’a rien à annuler', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx
      .http()
      .post(`/v1/me/orders/${paid.order.id}/cancel`)
      .set('Authorization', bearer(paid.accessToken))
      .expect(200);

    const row = await ctx.syncRow(paid.order.id);
    expect(row.status).toBe('SKIPPED');

    // Le drain ne pousse pas une commande annulée.
    const report = await ctx.drain();
    expect(report.processed).toBe(0);
    expect(ctx.shipstation.order(paid.order.number)).toBeUndefined();
  });

  it('une commande intégralement remboursée avant l’étiquette n’est jamais poussée', async () => {
    const paid = await paidOrderForUser(ctx);
    // Remboursement admin sans passer par l'annulation (tâche 12) : la
    // commande devient REFUNDED alors que sa ligne d'envoi est encore due.
    await ctx.app.get(RefundService).refund(paid.order.id, {
      restock: true,
      reason: 'Geste commercial',
      actor: { type: 'admin' },
    });
    expect(
      (await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } })).status,
    ).toBe('REFUNDED');

    await ctx.drain();

    expect((await ctx.syncRow(paid.order.id)).status).toBe('SKIPPED');
    expect(ctx.shipstation.order(paid.order.number)).toBeUndefined();
  });

  it('une étiquette déjà créée BLOQUE l’annulation automatique, avec un message explicite', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx.drain();

    // L'équipe d'expédition imprime l'étiquette ; le webhook nous l'apprend.
    const { shipment } = ctx.shipstation.createLabel(paid.order.number);
    await ctx.shipments.ingestMany([shipment]);

    const refused = await ctx
      .http()
      .post(`/v1/me/orders/${paid.order.id}/cancel`)
      .set('Authorization', bearer(paid.accessToken))
      .expect(409);
    expect(refused.body.code).toBe('LABEL_ALREADY_CREATED');
    expect(refused.body.message).toContain('étiquette');

    // Rien n'a bougé : la commande est expédiée, pas annulée.
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('SHIPPED');
    expect((await ctx.syncRow(paid.order.id)).status).toBe('SYNCED');
    expect(ctx.shipstation.order(paid.order.number)!.orderStatus).toBe('awaiting_shipment');
  });
});
