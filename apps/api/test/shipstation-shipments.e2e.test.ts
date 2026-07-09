import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastMail } from './auth-helpers';
import { paidOrderForUser } from './order-helpers';
import {
  createShipstationTestApp,
  postShipstationWebhook,
  type ShipstationTestContext,
} from './shipstation-helpers';

/**
 * Retour d'expédition ShipStation (tâche 13) — critères 2 et 4 du brief :
 *
 *   2. étiquette créée dans ShipStation ⇒ `shipment` chez nous, transporteur
 *      NORMALISÉ, numéro de suivi, commande `expédiée`, courriel parti ;
 *   4. webhook manqué ⇒ le polling de repli rattrape l'expédition.
 *
 * Plus la sécurité de l'endpoint et l'idempotence des relivraisons.
 */
describe('ShipStation — retour d’expédition (tâche 13)', () => {
  let ctx: ShipstationTestContext;

  beforeAll(async () => {
    ctx = await createShipstationTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Commande payée ET poussée dans ShipStation, prête à recevoir une étiquette. */
  async function pushedOrder(): Promise<Awaited<ReturnType<typeof paidOrderForUser>>> {
    const paid = await paidOrderForUser(ctx);
    await ctx.drain();
    return paid;
  }

  /* ------------------------ Critère 2 : étiquette → nous -------------------- */

  it('CRITÈRE 2 : le webhook crée l’expédition, normalise le transporteur, expédie la commande et envoie le courriel', async () => {
    const paid = await pushedOrder();
    const { body, shipment } = ctx.shipstation.createLabel(paid.order.number, {
      carrierCode: 'canada_post',
      serviceCode: 'canada_post_expedited_parcel',
      shipmentCost: 14.75,
    });

    const response = await postShipstationWebhook(ctx, body).expect(200);
    expect(response.body).toEqual({ received: true });

    const created = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { shipstationShipmentId: String(shipment.shipmentId) },
    });
    expect(created.orderId).toBe(paid.order.id);
    expect(created.carrier).toBe('CANADA_POST'); // « canada_post » → notre enum
    expect(created.carrierCode).toBe('canada_post');
    expect(created.serviceCode).toBe('canada_post_expedited_parcel');
    expect(created.trackingNumber).toBe(shipment.trackingNumber);
    expect(created.trackingUrl).toContain('canadapost-postescanada.ca');
    expect(created.costCents).toBe(1_475);
    expect(created.weightGrams).toBe(1_200);
    // 20 po × 2,54 = 50,8 cm
    expect(Number(created.lengthCm)).toBeCloseTo(50.8, 2);
    expect(created.shippedAt).toBeInstanceOf(Date);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('SHIPPED');
    expect(order.shippedAt).toBeInstanceOf(Date);

    const mail = lastMail(ctx, paid.email, 'order_shipped');
    expect(mail).toBeDefined();
    expect(mail!.variables.carrier).toBe('Postes Canada');
    expect(mail!.variables.trackingNumber).toBe(shipment.trackingNumber);
    expect(mail!.variables.trackingUrl).toContain(shipment.trackingNumber!);
  });

  it('Purolator (accessible seulement via ShipStation) est reconnu', async () => {
    const paid = await pushedOrder();
    const { body, shipment } = ctx.shipstation.createLabel(paid.order.number, {
      carrierCode: 'purolator',
      serviceCode: 'purolator_ground',
    });
    await postShipstationWebhook(ctx, body).expect(200);

    const created = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { shipstationShipmentId: String(shipment.shipmentId) },
    });
    expect(created.carrier).toBe('PUROLATOR');
    expect(created.trackingUrl).toContain('purolator.com');
    expect(lastMail(ctx, paid.email, 'order_shipped')!.variables.carrier).toBe('Purolator');
  });

  it('une relivraison du même webhook ne crée ni seconde expédition ni second courriel', async () => {
    const paid = await pushedOrder();
    const { body } = ctx.shipstation.createLabel(paid.order.number);

    await postShipstationWebhook(ctx, body).expect(200);
    const replay = await postShipstationWebhook(ctx, body).expect(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });

    expect(await ctx.prisma.shipment.count({ where: { orderId: paid.order.id } })).toBe(1);
    const mails = ctx.mail.outbox.filter(
      (entry) => entry.to === paid.email && entry.templateKey === 'order_shipped',
    );
    expect(mails).toHaveLength(1);
  });

  it('plusieurs colis pour une commande : autant d’expéditions, un seul courriel', async () => {
    const paid = await pushedOrder();
    const { body, shipments } = ctx.shipstation.createLabels(paid.order.number, 3);

    await postShipstationWebhook(ctx, body).expect(200);

    const rows = await ctx.prisma.shipment.findMany({ where: { orderId: paid.order.id } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.shipstationShipmentId))).toEqual(
      new Set(shipments.map((shipment) => String(shipment.shipmentId))),
    );

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('SHIPPED');
    const mails = ctx.mail.outbox.filter(
      (entry) => entry.to === paid.email && entry.templateKey === 'order_shipped',
    );
    expect(mails).toHaveLength(1);
  });

  it('une étiquette annulée (voided) n’expédie rien', async () => {
    const paid = await pushedOrder();
    const { body, shipment } = ctx.shipstation.createLabel(paid.order.number, { voided: true });

    await postShipstationWebhook(ctx, body).expect(200);

    expect(
      await ctx.prisma.shipment.findUnique({
        where: { shipstationShipmentId: String(shipment.shipmentId) },
      }),
    ).toBeNull();
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('PROCESSING');
  });

  it('une commande poussée mais restée PAYÉE franchit « en préparation » avant d’être expédiée', async () => {
    const paid = await pushedOrder();
    // Simule une transition PROCESSING perdue (redémarrage entre les deux).
    await ctx.prisma.order.update({ where: { id: paid.order.id }, data: { status: 'PAID' } });

    const { body } = ctx.shipstation.createLabel(paid.order.number);
    await postShipstationWebhook(ctx, body).expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('SHIPPED');
    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { orderId: paid.order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((entry) => entry.toStatus)).toContain('PROCESSING');
  });

  /* --------------------------- Sécurité de l’endpoint ----------------------- */

  it('l’endpoint de webhook exige le secret partagé', async () => {
    const paid = await pushedOrder();
    const { body } = ctx.shipstation.createLabel(paid.order.number);

    await postShipstationWebhook(ctx, body, 'mauvais-secret').expect(401);
    await ctx.http().post('/v1/webhooks/shipstation').send(body).expect(401);
    // En-tête accepté à la place du paramètre d’URL.
    await ctx
      .http()
      .post('/v1/webhooks/shipstation')
      .set('x-shipstation-token', 'mauvais-secret')
      .send(body)
      .expect(401);

    expect(await ctx.prisma.shipment.count({ where: { orderId: paid.order.id } })).toBe(0);
    expect(
      await ctx.prisma.webhookEvent.count({ where: { source: 'shipstation' } }),
    ).toBeGreaterThan(0);
  });

  it('un corps sans resource_url est refusé, et les autres types d’événements sont ignorés', async () => {
    await postShipstationWebhook(ctx, { resource_url: '', resource_type: 'SHIP_NOTIFY' }).expect(
      400,
    );

    const paid = await pushedOrder();
    const { body } = ctx.shipstation.createLabel(paid.order.number);
    await postShipstationWebhook(ctx, { ...body, resource_type: 'ORDER_NOTIFY' }).expect(200);

    const event = await ctx.prisma.webhookEvent.findUniqueOrThrow({
      where: { source_externalId: { source: 'shipstation', externalId: body.resource_url } },
    });
    expect(event.status).toBe('IGNORED');
    expect(await ctx.prisma.shipment.count({ where: { orderId: paid.order.id } })).toBe(0);
  });

  /* ------------------- Critère 4 : le polling rattrape le webhook ------------ */

  it('CRITÈRE 4 : webhook manqué ⇒ le polling de repli récupère l’expédition et expédie la commande', async () => {
    const paid = await pushedOrder();
    // L'étiquette est créée… et le webhook n'arrive JAMAIS.
    const { shipment } = ctx.shipstation.createLabel(paid.order.number, {
      carrierCode: 'nationex',
      serviceCode: 'nationex_standard',
    });
    expect(await ctx.prisma.shipment.count({ where: { orderId: paid.order.id } })).toBe(0);

    const report = await ctx.shipments.pollRecentShipments();
    expect(report.created).toBeGreaterThanOrEqual(1);
    expect(report.ordersShipped).toBeGreaterThanOrEqual(1);

    const created = await ctx.prisma.shipment.findUniqueOrThrow({
      where: { shipstationShipmentId: String(shipment.shipmentId) },
    });
    expect(created.carrier).toBe('NATIONEX');
    expect(created.trackingNumber).toBe(shipment.trackingNumber);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
    expect(order.status).toBe('SHIPPED');
    expect(lastMail(ctx, paid.email, 'order_shipped')).toBeDefined();
  });

  it('le polling rejoué n’ajoute rien (idempotent)', async () => {
    const paid = await pushedOrder();
    ctx.shipstation.createLabel(paid.order.number);

    await ctx.shipments.pollRecentShipments();
    const before = await ctx.prisma.shipment.count();
    const second = await ctx.shipments.pollRecentShipments();

    expect(second.created).toBe(0);
    expect(await ctx.prisma.shipment.count()).toBe(before);
    const mails = ctx.mail.outbox.filter(
      (entry) => entry.to === paid.email && entry.templateKey === 'order_shipped',
    );
    expect(mails).toHaveLength(1);
  });
});
