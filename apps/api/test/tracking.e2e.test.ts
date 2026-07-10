import { type Carrier, trackingUrlFor } from '@ffc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createUserInDb,
  login,
  registerAndVerify,
  TEST_SHIPSTATION_WEBHOOK_SECRET,
  totpCode,
  uniqueEmail,
} from './auth-helpers';
import { paidOrderForUser } from './order-helpers';
import {
  createTrackingTestApp,
  expectWithinMinutes,
  type TrackingTestContext,
} from './tracking-helpers';

/**
 * Suivi de colis multi-transporteurs (tâche 14) — critères d'acceptation :
 *
 *   1. séquence complète de fixtures jusqu'à « livré » pour CHAQUE
 *      transporteur, chronologie propre et dédupliquée ;
 *   2. panne Purolator d'une heure : les trois autres continuent, l'alerte
 *      « échoue en série » se lève, la reprise ne perd aucun événement ;
 *   3. chaque jalon notifie UNE seule fois, même quand le polling rejoue
 *      les mêmes événements ;
 *   4. « Mes colis » montre les colis de plusieurs transporteurs à des
 *      statuts différents — et seulement ceux du compte connecté ;
 *   5. la cadence passe à 1 h en livraison et s'arrête à la livraison.
 *
 * Les quatre adapters RÉELS tournent sur des fixtures anonymisées ; seul le
 * fil réseau (TrackingHttp) est un faux. Le scan est appelé explicitement.
 */
describe('Suivi de colis multi-transporteurs (tâche 14)', () => {
  let ctx: TrackingTestContext;

  beforeAll(async () => {
    ctx = await createTrackingTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /* -------------------------------- Aides --------------------------------- */

  function mailsTo(to: string, templateKey: string): number {
    return ctx.mail.outbox.filter((entry) => entry.to === to && entry.templateKey === templateKey)
      .length;
  }

  function pushesTo(userId: string, templateKey: string): number {
    return ctx.push.outbox.filter(
      (entry) => entry.userId === userId && entry.templateKey === templateKey,
    ).length;
  }

  /** Fait avancer le colis d'une étape : fixture + colis dû + un scan. */
  async function advance(carrier: Carrier, shipmentId: string, fixtureName: string) {
    ctx.stage(carrier, fixtureName);
    await ctx.makeDue(shipmentId);
    return ctx.scan();
  }

  /* ------------------ CRITÈRE 1 : séquence complète × 4 ------------------- */

  const SEQUENCES = [
    {
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
      ext: 'xml',
      totalEvents: 4,
      deliveredCode: '1496',
      deliveredAt: '2026-07-15T18:04:51.000Z',
      eta: '2026-07-15T12:00:00.000Z',
      unmappedCode: null,
    },
    {
      carrier: 'NATIONEX',
      trackingNumber: 'NX100200300',
      ext: 'json',
      totalEvents: 5,
      deliveredCode: 'LV',
      deliveredAt: '2026-07-15T17:44:09.000Z',
      eta: '2026-07-15T12:00:00.000Z',
      unmappedCode: 'SC',
    },
    {
      // L'ETA Canpar est un « yyyyMMdd 000000 » local : minuit de l'Est.
      carrier: 'CANPAR',
      trackingNumber: 'D420001122334455',
      ext: 'xml',
      totalEvents: 5,
      deliveredCode: 'DEL',
      deliveredAt: '2026-07-15T18:12:33.000Z',
      eta: '2026-07-15T04:00:00.000Z',
      unmappedCode: null,
    },
    {
      // Le scan « Other » vu à l'étape 2 n'est plus renvoyé ensuite : il
      // reste en base (5 événements) — l'historique ne perd rien.
      carrier: 'PUROLATOR',
      trackingNumber: '331200000001',
      ext: 'xml',
      totalEvents: 5,
      deliveredCode: 'Delivery',
      deliveredAt: '2026-07-15T17:59:40.000Z',
      eta: null,
      unmappedCode: 'Other',
    },
  ] as const;

  const STAGES = [
    { fixture: '01-picked-up', status: 'PICKED_UP' },
    { fixture: '02-in-transit', status: 'IN_TRANSIT' },
    { fixture: '03-out-for-delivery', status: 'OUT_FOR_DELIVERY' },
    { fixture: '04-delivered', status: 'DELIVERED' },
  ] as const;

  it.each(SEQUENCES)(
    'CRITÈRE 1 : $carrier — la séquence complète mène à « livré » avec une chronologie dédupliquée',
    async (seq) => {
      const shipped = await ctx.makeShippedShipment({
        carrier: seq.carrier,
        trackingNumber: seq.trackingNumber,
      });
      await ctx.registerDevice(shipped.userId);

      // Chaque étape renvoie l'HISTORIQUE COMPLET (comme les vraies API) :
      // la déduplication doit absorber tous les rejeux.
      for (const stage of STAGES) {
        const report = await advance(
          seq.carrier,
          shipped.shipmentId,
          `${stage.fixture}.${seq.ext}`,
        );
        expect(report).toEqual({
          claimed: 1,
          ok: 1,
          notFound: 0,
          failed: 0,
          unconfigured: 0,
          transitions: 1,
        });
        expect((await ctx.shipmentRow(shipped.shipmentId)).status).toBe(stage.status);
      }

      // Colis : livré, horodatages exacts, polling arrêté DÉFINITIVEMENT.
      const row = await ctx.shipmentRow(shipped.shipmentId);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt?.toISOString()).toBe(seq.deliveredAt);
      expect(row.estimatedDeliveryAt?.toISOString() ?? null).toBe(seq.eta);
      expect(row.nextPollAt).toBeNull();
      expect(row.pollFailures).toBe(0);

      // Chronologie : chaque événement UNE fois, du plus récent au plus ancien.
      const events = await ctx.prisma.shipmentEvent.findMany({
        where: { shipmentId: shipped.shipmentId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(events).toHaveLength(seq.totalEvents);
      expect(new Set(events.map((event) => event.dedupKey)).size).toBe(seq.totalEvents);
      expect(events[0]!.code).toBe(seq.deliveredCode);
      expect(events[0]!.status).toBe('DELIVERED');
      expect(events[0]!.occurredAt.toISOString()).toBe(seq.deliveredAt);
      if (seq.unmappedCode) {
        // Les scans non cartographiés sont conservés, sans statut.
        expect(events.find((event) => event.code === seq.unmappedCode)!.status).toBeNull();
      }

      // Commande livrée (machine d'états de la tâche 12) + jalons notifiés.
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: shipped.orderId } });
      expect(order.status).toBe('DELIVERED');
      expect(order.deliveredAt).toBeInstanceOf(Date);
      expect(mailsTo(shipped.email, 'shipment_out_for_delivery')).toBe(1);
      expect(mailsTo(shipped.email, 'order_delivered')).toBe(1);
      expect(pushesTo(shipped.userId, 'shipment_out_for_delivery')).toBe(1);
      expect(pushesTo(shipped.userId, 'order_delivered')).toBe(1);
    },
  );

  /* ------------- CRITÈRE 2 : panne Purolator, isolation, reprise ----------- */

  it('CRITÈRE 2 : Purolator en panne — les trois autres continuent, alerte levée, reprise sans perte', async () => {
    const cp = await ctx.makeShippedShipment({
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
    });
    const nx = await ctx.makeShippedShipment({
      carrier: 'NATIONEX',
      trackingNumber: 'NX100200300',
    });
    const cnp = await ctx.makeShippedShipment({
      carrier: 'CANPAR',
      trackingNumber: 'D420001122334455',
    });
    const puro = await ctx.makeShippedShipment({
      carrier: 'PUROLATOR',
      trackingNumber: '331200000001',
    });
    const healthy = [cp, nx, cnp];

    // Tout le monde démarre sainement (pris en charge).
    ctx.stage('CANADA_POST', '01-picked-up.xml');
    ctx.stage('NATIONEX', '01-picked-up.json');
    ctx.stage('CANPAR', '01-picked-up.xml');
    ctx.stage('PUROLATOR', '01-picked-up.xml');
    expect(await ctx.scan()).toMatchObject({ claimed: 4, ok: 4, failed: 0 });

    // PANNE Purolator. Les quatre colis sont dus dans le MÊME scan.
    ctx.trackingHttp.failNetwork('PUROLATOR');
    ctx.stage('CANADA_POST', '02-in-transit.xml');
    ctx.stage('NATIONEX', '02-in-transit.json');
    ctx.stage('CANPAR', '02-in-transit.xml');
    for (const shipment of [cp, nx, cnp, puro]) await ctx.makeDue(shipment.shipmentId);

    expect(await ctx.scan()).toMatchObject({ claimed: 4, ok: 3, failed: 1 });

    // ISOLATION : les trois autres ont avancé normalement, cadence intacte.
    for (const shipment of healthy) {
      const row = await ctx.shipmentRow(shipment.shipmentId);
      expect(row.status).toBe('IN_TRANSIT');
      expect(row.pollFailures).toBe(0);
      expectWithinMinutes(row.nextPollAt, 350, 361);
    }
    // Purolator : échec encaissé, PREMIER recul (15 min), rien de perdu.
    let puroRow = await ctx.shipmentRow(puro.shipmentId);
    expect(puroRow.status).toBe('PICKED_UP');
    expect(puroRow.pollFailures).toBe(1);
    expectWithinMinutes(puroRow.nextPollAt, 13, 16);
    expect(await ctx.prisma.shipmentEvent.count({ where: { shipmentId: puro.shipmentId } })).toBe(
      1,
    );

    // La panne persiste ≈ 1 h : les retentatives suivantes échouent aussi.
    // Les trois autres, replanifiés à +6 h, ne sont PAS re-sollicités.
    const callsBefore = {
      CANADA_POST: ctx.trackingHttp.callsFor('CANADA_POST').length,
      NATIONEX: ctx.trackingHttp.callsFor('NATIONEX').length,
      CANPAR: ctx.trackingHttp.callsFor('CANPAR').length,
    };
    for (let failure = 2; failure <= 5; failure += 1) {
      await ctx.makeDue(puro.shipmentId);
      expect(await ctx.scan()).toMatchObject({ claimed: 1, failed: 1 });
    }
    for (const [carrier, count] of Object.entries(callsBefore)) {
      expect(ctx.trackingHttp.callsFor(carrier as Carrier)).toHaveLength(count);
    }

    // Recul exponentiel plafonné + ALERTE « échoue en série » (5 échecs).
    puroRow = await ctx.shipmentRow(puro.shipmentId);
    expect(puroRow.pollFailures).toBe(5);
    expectWithinMinutes(puroRow.nextPollAt, 235, 241);
    const during = ctx.metrics.snapshotFor('PUROLATOR');
    expect(during?.alertActive).toBe(true);
    expect(during?.consecutiveFailures).toBe(5);

    // L'observabilité admin expose l'alerte et l'état du transporteur.
    const overview = await ctx.adminTracking.overview();
    const puroOverview = overview.carriers.find((entry) => entry.carrier === 'PUROLATOR')!;
    expect(puroOverview.configured).toBe(true);
    expect(puroOverview.metrics?.alertActive).toBe(true);
    expect(puroOverview.active).toBeGreaterThanOrEqual(1);

    // FIN de panne : le repérage suivant relit l'historique complet — la
    // reprise ne perd rien (livraison + événements intermédiaires jamais vus).
    ctx.trackingHttp.heal('PUROLATOR');
    expect(await advance('PUROLATOR', puro.shipmentId, '04-delivered.xml')).toMatchObject({
      ok: 1,
      failed: 0,
      transitions: 1,
    });

    puroRow = await ctx.shipmentRow(puro.shipmentId);
    expect(puroRow.status).toBe('DELIVERED');
    expect(puroRow.deliveredAt?.toISOString()).toBe('2026-07-15T17:59:40.000Z');
    expect(puroRow.pollFailures).toBe(0);
    expect(puroRow.nextPollAt).toBeNull();
    // 01 (ProofOfPickUp) ∪ 04 (Delivery, OnDelivery, Depot, ProofOfPickUp) = 4.
    expect(await ctx.prisma.shipmentEvent.count({ where: { shipmentId: puro.shipmentId } })).toBe(
      4,
    );

    const after = ctx.metrics.snapshotFor('PUROLATOR');
    expect(after?.alertActive).toBe(false);
    expect(after?.consecutiveFailures).toBe(0);

    // Les trois autres terminent leur route comme si de rien n'était.
    await advance('CANADA_POST', cp.shipmentId, '04-delivered.xml');
    await advance('NATIONEX', nx.shipmentId, '04-delivered.json');
    await advance('CANPAR', cnp.shipmentId, '04-delivered.xml');
    for (const shipment of healthy) {
      expect((await ctx.shipmentRow(shipment.shipmentId)).status).toBe('DELIVERED');
    }
  });

  /* ------------- CRITÈRE 3 : jalons notifiés UNE seule fois ---------------- */

  it('CRITÈRE 3 : en livraison, incident, livré — chaque jalon notifie une seule fois malgré les rejeux', async () => {
    const shipped = await ctx.makeShippedShipment({
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
    });
    await ctx.registerDevice(shipped.userId);

    // Pris en charge : chronologie seulement, AUCUNE notification.
    await advance('CANADA_POST', shipped.shipmentId, '01-picked-up.xml');
    expect(mailsTo(shipped.email, 'shipment_out_for_delivery')).toBe(0);
    expect(pushesTo(shipped.userId, 'shipment_out_for_delivery')).toBe(0);

    // EN LIVRAISON → courriel + push, une fois.
    await advance('CANADA_POST', shipped.shipmentId, '03-out-for-delivery.xml');
    expect(mailsTo(shipped.email, 'shipment_out_for_delivery')).toBe(1);
    expect(pushesTo(shipped.userId, 'shipment_out_for_delivery')).toBe(1);

    // REJEU du même historique : aucun nouvel événement, aucune renotification.
    await advance('CANADA_POST', shipped.shipmentId, '03-out-for-delivery.xml');
    expect(
      await ctx.prisma.shipmentEvent.count({ where: { shipmentId: shipped.shipmentId } }),
    ).toBe(3);
    expect(mailsTo(shipped.email, 'shipment_out_for_delivery')).toBe(1);
    expect(pushesTo(shipped.userId, 'shipment_out_for_delivery')).toBe(1);

    // INCIDENT (avis de passage) → courriel + push, une fois ; cadence prudente.
    await advance('CANADA_POST', shipped.shipmentId, 'exception.xml');
    let row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('EXCEPTION');
    expectWithinMinutes(row.nextPollAt, 714, 721);
    expect(mailsTo(shipped.email, 'shipment_exception')).toBe(1);
    expect(pushesTo(shipped.userId, 'shipment_exception')).toBe(1);

    await advance('CANADA_POST', shipped.shipmentId, 'exception.xml'); // rejeu
    expect(mailsTo(shipped.email, 'shipment_exception')).toBe(1);
    expect(pushesTo(shipped.userId, 'shipment_exception')).toBe(1);

    // LIVRÉ → la commande passe « livrée » (tâche 12) : courriel + push, une fois.
    await advance('CANADA_POST', shipped.shipmentId, '04-delivered.xml');
    row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('DELIVERED');
    expect(row.nextPollAt).toBeNull();
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: shipped.orderId } });
    expect(order.status).toBe('DELIVERED');
    expect(mailsTo(shipped.email, 'order_delivered')).toBe(1);
    expect(pushesTo(shipped.userId, 'order_delivered')).toBe(1);

    // ARRÊT DÉFINITIF : même forcé « dû », un colis livré n'est plus repéré.
    const callsBefore = ctx.trackingHttp.callsFor('CANADA_POST').length;
    await ctx.prisma.shipment.update({
      where: { id: shipped.shipmentId },
      data: { nextPollAt: new Date(Date.now() - 1_000) },
    });
    expect(await ctx.scan()).toMatchObject({ claimed: 0 });
    expect(ctx.trackingHttp.callsFor('CANADA_POST')).toHaveLength(callsBefore);
    expect(mailsTo(shipped.email, 'order_delivered')).toBe(1);
    await ctx.prisma.shipment.update({
      where: { id: shipped.shipmentId },
      data: { nextPollAt: null },
    });
  });

  it('respecte les préférences : courriel et push explicitement désactivés → traces SKIPPED, aucun envoi', async () => {
    const shipped = await ctx.makeShippedShipment({
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
    });
    await ctx.registerDevice(shipped.userId);
    await ctx.prisma.notificationPreference.createMany({
      data: (['EMAIL', 'PUSH'] as const).map((channel) => ({
        userId: shipped.userId,
        category: 'TRANSACTIONAL' as const,
        channel,
        enabled: false,
      })),
    });

    await advance('CANADA_POST', shipped.shipmentId, '03-out-for-delivery.xml');
    expect((await ctx.shipmentRow(shipped.shipmentId)).status).toBe('OUT_FOR_DELIVERY');
    expect(mailsTo(shipped.email, 'shipment_out_for_delivery')).toBe(0);
    expect(pushesTo(shipped.userId, 'shipment_out_for_delivery')).toBe(0);

    // La désactivation CONSOMME le jalon (trace SKIPPED) : rien au rejeu non plus.
    const skipped = await ctx.prisma.notification.findMany({
      where: { userId: shipped.userId, status: 'SKIPPED' },
    });
    expect(skipped).toHaveLength(2);
    await advance('CANADA_POST', shipped.shipmentId, '03-out-for-delivery.xml');
    expect(
      await ctx.prisma.notification.count({ where: { userId: shipped.userId, status: 'SKIPPED' } }),
    ).toBe(2);
  });

  /* ---------------------- CRITÈRE 4 : « Mes colis » ------------------------ */

  it('CRITÈRE 4 : « Mes colis » montre trois transporteurs à trois statuts — au bon compte seulement', async () => {
    // Une commande, TROIS colis (envoi éclaté) : Postes Canada livré,
    // Nationex en livraison, Canpar en transit.
    const shipped = await ctx.makeShippedShipment({
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
    });
    const extras: Record<'NATIONEX' | 'CANPAR', string> = { NATIONEX: '', CANPAR: '' };
    for (const [carrier, trackingNumber] of [
      ['NATIONEX', 'NX100200300'],
      ['CANPAR', 'D420001122334455'],
    ] as const) {
      const extra = await ctx.prisma.shipment.create({
        data: {
          orderId: shipped.orderId,
          carrier,
          trackingNumber,
          trackingUrl: trackingUrlFor(carrier, trackingNumber, 'fr'),
          status: 'CREATED',
          shippedAt: new Date(),
          nextPollAt: new Date(Date.now() - 1_000),
        },
      });
      extras[carrier] = extra.id;
    }

    ctx.stage('CANADA_POST', '04-delivered.xml');
    ctx.stage('NATIONEX', '03-out-for-delivery.json');
    ctx.stage('CANPAR', '02-in-transit.xml');
    expect(await ctx.scan()).toMatchObject({ claimed: 3, ok: 3 });

    // Un colis livré sur trois : la commande N'EST PAS livrée (multi-colis).
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: shipped.orderId } });
    expect(order.status).toBe('SHIPPED');
    expect(mailsTo(shipped.email, 'order_delivered')).toBe(0);

    interface ApiEvent {
      code: string | null;
      status: string | null;
      statusLabel: string | null;
      occurredAt: string;
    }
    interface ApiShipment {
      id: string;
      orderId: string;
      orderNumber: string;
      carrier: string | null;
      carrierLabel: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      status: string;
      statusLabel: string;
      isActive: boolean;
      estimatedDeliveryAt: string | null;
      deliveredAt: string | null;
      events: ApiEvent[];
    }

    const response = await ctx
      .http()
      .get('/v1/me/shipments')
      .set('Authorization', bearer(shipped.accessToken))
      .expect(200);
    const body = response.body as { items: ApiShipment[]; nextCursor: string | null };
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(new Set(body.items.map((item) => item.status))).toEqual(
      new Set(['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT']),
    );

    const byCarrier = new Map(body.items.map((item) => [item.carrier, item]));
    const delivered = byCarrier.get('CANADA_POST')!;
    expect(delivered.statusLabel).toBe('Livré'); // locale du compte : fr
    expect(delivered.carrierLabel).toBe('Postes Canada');
    expect(delivered.isActive).toBe(false); // historique
    expect(delivered.orderNumber).toBe(shipped.orderNumber);
    expect(delivered.deliveredAt).toBe('2026-07-15T18:04:51.000Z');
    expect(delivered.trackingUrl).toContain(shipped.trackingNumber);
    // Chronologie unifiée : du plus récent au plus ancien, libellés localisés.
    expect(delivered.events.map((event) => event.code)).toEqual(['1496', '0174', '0100', '3000']);
    expect(delivered.events[0]!.statusLabel).toBe('Livré');

    const outForDelivery = byCarrier.get('NATIONEX')!;
    expect(outForDelivery.isActive).toBe(true);
    expect(outForDelivery.statusLabel).toBe('En livraison');
    expect(outForDelivery.estimatedDeliveryAt).toBe('2026-07-15T12:00:00.000Z');
    expect(outForDelivery.events).toHaveLength(4);

    const inTransit = byCarrier.get('CANPAR')!;
    expect(inTransit.statusLabel).toBe('En transit');
    expect(inTransit.events).toHaveLength(3);

    // Pagination par curseur : 2 + 1, sans chevauchement.
    const page1 = await ctx
      .http()
      .get('/v1/me/shipments')
      .query({ limit: 2 })
      .set('Authorization', bearer(shipped.accessToken))
      .expect(200);
    const first = page1.body as { items: ApiShipment[]; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const page2 = await ctx
      .http()
      .get('/v1/me/shipments')
      .query({ limit: 2, cursor: first.nextCursor })
      .set('Authorization', bearer(shipped.accessToken))
      .expect(200);
    const second = page2.body as { items: ApiShipment[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(body.items.map((item) => item.id)),
    );

    // Réservé au compte : anonyme → 401 ; un AUTRE compte ne voit rien.
    await ctx.http().get('/v1/me/shipments').expect(401);
    const otherEmail = uniqueEmail('colis-autrui');
    await registerAndVerify(ctx, otherEmail);
    const other = await login(ctx, otherEmail);
    const empty = await ctx
      .http()
      .get('/v1/me/shipments')
      .set('Authorization', bearer(other.accessToken))
      .expect(200);
    expect((empty.body as { items: unknown[] }).items).toEqual([]);

    // Les deux derniers colis arrivent : la commande devient LIVRÉE, un
    // seul courriel de livraison pour l'ensemble.
    await advance('NATIONEX', extras.NATIONEX, '04-delivered.json');
    await advance('CANPAR', extras.CANPAR, '04-delivered.xml');
    const finalOrder = await ctx.prisma.order.findUniqueOrThrow({ where: { id: shipped.orderId } });
    expect(finalOrder.status).toBe('DELIVERED');
    expect(mailsTo(shipped.email, 'order_delivered')).toBe(1);
  });

  /* ------------- CRITÈRE 5 : cadence adaptative de bout en bout ------------ */

  it('CRITÈRE 5 : la cadence passe de 6 h à 1 h en livraison, et s’arrête à la livraison', async () => {
    const shipped = await ctx.makeShippedShipment({
      carrier: 'CANPAR',
      trackingNumber: 'D420001122334455',
    });

    await advance('CANPAR', shipped.shipmentId, '01-picked-up.xml');
    let row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('PICKED_UP');
    expectWithinMinutes(row.nextPollAt, 350, 361); // cadence par défaut : 6 h

    await advance('CANPAR', shipped.shipmentId, '02-in-transit.xml');
    row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('IN_TRANSIT');
    expectWithinMinutes(row.nextPollAt, 350, 361);

    await advance('CANPAR', shipped.shipmentId, '03-out-for-delivery.xml');
    row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('OUT_FOR_DELIVERY');
    expectWithinMinutes(row.nextPollAt, 55, 61); // à l'approche : 1 h

    await advance('CANPAR', shipped.shipmentId, '04-delivered.xml');
    row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('DELIVERED');
    expect(row.nextPollAt).toBeNull(); // arrêt définitif
  });

  it('numéro encore inconnu du transporteur : pas une erreur, on repasse dans l’heure', async () => {
    const shipped = await ctx.makeShippedShipment({
      carrier: 'PUROLATOR',
      trackingNumber: '331200000001',
    });

    ctx.stage('PUROLATOR', 'not-found.xml');
    expect(await ctx.scan()).toMatchObject({ claimed: 1, notFound: 1, ok: 0, failed: 0 });
    let row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('CREATED');
    expect(row.pollFailures).toBe(0); // « inconnu » n'est PAS un échec
    expectWithinMinutes(row.nextPollAt, 55, 61);
    expect(
      await ctx.prisma.shipmentEvent.count({ where: { shipmentId: shipped.shipmentId } }),
    ).toBe(0);

    // Le transporteur finit par connaître le numéro : le suivi démarre.
    await advance('PUROLATOR', shipped.shipmentId, '01-picked-up.xml');
    row = await ctx.shipmentRow(shipped.shipmentId);
    expect(row.status).toBe('PICKED_UP');
  });

  /* --------------- Chaînage tâche 13 → 14 et observabilité ----------------- */

  it('une étiquette ShipStation (tâche 13) planifie le premier repérage à +15 min', async () => {
    const paid = await paidOrderForUser(ctx);
    await ctx.drainShipstation();
    const { body } = ctx.shipstation.createLabel(paid.order.number, {
      carrierCode: 'canada_post',
    });
    await ctx
      .http()
      .post(`/v1/webhooks/shipstation?token=${encodeURIComponent(TEST_SHIPSTATION_WEBHOOK_SECRET)}`)
      .send(body)
      .expect(200);

    const shipment = await ctx.prisma.shipment.findFirstOrThrow({
      where: { orderId: paid.order.id },
    });
    expect(shipment.carrier).toBe('CANADA_POST');
    expectWithinMinutes(shipment.nextPollAt, 13, 16);
  });

  it('l’observabilité admin est servie par /v1/admin/tracking sous le RBAC de la tâche 09', async () => {
    // Compte du personnel avec MFA active et le rôle qui porte shipments.read.
    const { user, email, password } = await createUserInDb(ctx, {
      email: uniqueEmail('adm-trk'),
      role: 'ADMIN',
    });
    const session = await login(ctx, email, password);
    const enroll = await ctx
      .http()
      .post('/v1/auth/mfa/enroll')
      .set('Authorization', bearer(session.accessToken))
      .expect(200);
    const activated = await ctx
      .http()
      .post('/v1/auth/mfa/activate')
      .set('Authorization', bearer(session.accessToken))
      .send({ code: totpCode(enroll.body.secretBase32 as string) })
      .expect(200);
    const roles = await ctx.prisma.role.findMany({ where: { key: 'commandes' } });
    expect(roles).toHaveLength(1);
    await ctx.prisma.userRoleAssignment.create({
      data: { userId: user.id, roleId: roles[0]!.id },
    });
    const step1 = await ctx
      .http()
      .post('/v1/admin/auth/login')
      .send({ email, password })
      .expect(200);
    const step2 = await ctx
      .http()
      .post('/v1/admin/auth/login/mfa')
      .send({
        challengeToken: step1.body.challengeToken,
        code: (activated.body.recoveryCodes as string[])[0]!,
      })
      .expect(200);
    const adminToken = step2.body.accessToken as string;

    const response = await ctx
      .http()
      .get('/v1/admin/tracking')
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const overview = response.body as {
      staleDays: number;
      carriers: Array<{ carrier: string; configured: boolean; metrics: unknown }>;
      staleShipments: unknown[];
    };
    expect(overview.staleDays).toBe(5);
    expect(new Set(overview.carriers.map((entry) => entry.carrier))).toEqual(
      new Set(['CANADA_POST', 'NATIONEX', 'CANPAR', 'PUROLATOR']),
    );
    expect(overview.carriers.every((entry) => entry.configured)).toBe(true);

    // Le client, lui, n'y a pas accès (ni anonyme).
    await ctx.http().get('/v1/admin/tracking').expect(401);
    const customer = await ctx.makeShippedShipment({
      carrier: 'CANADA_POST',
      trackingNumber: '7023210039414604',
    });
    await ctx
      .http()
      .get('/v1/admin/tracking')
      .set('Authorization', bearer(customer.accessToken))
      .expect(403);
  });
});
