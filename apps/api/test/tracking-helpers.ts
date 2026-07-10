import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Carrier, trackingUrlFor } from '@ffc/core';
import { type Shipment } from '@prisma/client';
import { PushService } from '../src/modules/push/push.service';
import { ShipstationSyncService } from '../src/modules/shipping/shipstation/shipstation-sync.service';
import { TrackingAdminService } from '../src/modules/shipping/tracking/tracking-admin.service';
import { TrackingIngestService } from '../src/modules/shipping/tracking/tracking-ingest.service';
import { TrackingMetricsService } from '../src/modules/shipping/tracking/tracking-metrics.service';
import {
  type ScanReport,
  TrackingPollerService,
} from '../src/modules/shipping/tracking/tracking-poller.service';
import { type CheckoutTestContext, createCheckoutTestApp } from './checkout-helpers';
import { FakeShipstationClient } from './fakes/fake-shipstation';
import { FakeTrackingHttp } from './fakes/fake-tracking-http';
import { paidOrderForUser } from './order-helpers';

/**
 * Contexte des e2e de suivi de colis (tâche 14) : application complète,
 * faux Stripe/ShipStation ET faux fil réseau de repérage (FakeTrackingHttp).
 * Les quatre adapters RÉELS tournent (auth, URL, parsing XML/JSON/SOAP,
 * tables de correspondance) sur des fixtures de réponses anonymisées.
 * Le scan est appelé EXPLICITEMENT (aucune minuterie en NODE_ENV=test).
 */

/** Clés d'accès factices : les quatre adapters se déclarent configurés. */
const TRACKING_TEST_ENV: Record<string, string> = {
  CANADA_POST_API_USERNAME: 'cpc-test',
  CANADA_POST_API_PASSWORD: 'cpc-secret',
  NATIONEX_CUSTOMER_ID: '104200',
  NATIONEX_API_KEY: 'nx-secret',
  CANPAR_API_USERNAME: 'canpar@test.ffc.local',
  CANPAR_API_PASSWORD: 'canpar-secret',
  PUROLATOR_API_KEY: 'puro-key',
  PUROLATOR_API_PASSWORD: 'puro-secret',
  PUSH_DRIVER: 'log',
};

/** Répertoires de fixtures par transporteur. */
const FIXTURE_DIRS: Partial<Record<Carrier, string>> = {
  CANADA_POST: 'canada-post',
  NATIONEX: 'nationex',
  CANPAR: 'canpar',
  PUROLATOR: 'purolator',
};

/** Corps brut d'une fixture de réponse transporteur. */
export function trackingFixture(carrier: Carrier, name: string): string {
  const dir = FIXTURE_DIRS[carrier];
  if (!dir) throw new Error(`Aucune fixture pour ${carrier}`);
  return readFileSync(join(__dirname, 'fixtures', 'tracking', dir, name), 'utf8');
}

export interface ShippedShipment {
  orderId: string;
  orderNumber: string;
  userId: string;
  email: string;
  accessToken: string;
  shipmentId: string;
  trackingNumber: string;
}

export interface TrackingTestContext extends CheckoutTestContext {
  trackingHttp: FakeTrackingHttp;
  /** Faux ShipStation : parcours réel « étiquette → colis suivi » (tâche 13). */
  shipstation: FakeShipstationClient;
  poller: TrackingPollerService;
  ingest: TrackingIngestService;
  metrics: TrackingMetricsService;
  push: PushService;
  adminTracking: TrackingAdminService;
  scan: () => Promise<ScanReport>;
  /** Pousse les commandes payées en attente vers le faux ShipStation. */
  drainShipstation: () => Promise<unknown>;
  /** Prépare la prochaine réponse du transporteur depuis une fixture. */
  stage: (carrier: Carrier, fixtureName: string) => void;
  /** Rend le colis immédiatement dû (court-circuite la cadence). */
  makeDue: (shipmentId: string) => Promise<void>;
  shipmentRow: (shipmentId: string) => Promise<Shipment>;
  /** Enregistre un appareil mobile (tâche 19) : cible des push. */
  registerDevice: (userId: string) => Promise<void>;
  /**
   * Commande PAYÉE puis EXPÉDIÉE (statut posé directement — le parcours
   * webhook ShipStation complet est couvert par la suite de la tâche 13),
   * avec un colis suivi dû immédiatement.
   */
  makeShippedShipment: (params: {
    carrier: Carrier;
    trackingNumber: string;
    locale?: 'fr' | 'en';
  }) => Promise<ShippedShipment>;
}

export async function createTrackingTestApp(): Promise<TrackingTestContext> {
  for (const [key, value] of Object.entries(TRACKING_TEST_ENV)) process.env[key] = value;

  const trackingHttp = new FakeTrackingHttp();
  const shipstation = new FakeShipstationClient();
  const ctx = await createCheckoutTestApp({ trackingHttp, shipstation });

  // La base ffc_test est PARTAGÉE : les suites précédentes (checkout,
  // factures, tâche 13…) ont pu laisser des colis avec un `next_poll_at`
  // passé que scan() ramasserait. On neutralise l'existant pour que les
  // rapports de scan de CE fichier ne parlent que de ses propres colis.
  await ctx.prisma.shipment.updateMany({
    where: { nextPollAt: { not: null } },
    data: { nextPollAt: null },
  });

  return {
    ...ctx,
    trackingHttp,
    shipstation,
    poller: ctx.app.get(TrackingPollerService),
    ingest: ctx.app.get(TrackingIngestService),
    metrics: ctx.app.get(TrackingMetricsService),
    push: ctx.app.get(PushService),
    adminTracking: ctx.app.get(TrackingAdminService),
    scan: () => ctx.app.get(TrackingPollerService).scan(),
    drainShipstation: () => ctx.app.get(ShipstationSyncService).drain(),
    stage: (carrier, fixtureName) =>
      trackingHttp.stage(carrier, trackingFixture(carrier, fixtureName)),
    makeDue: async (shipmentId) => {
      await ctx.prisma.shipment.update({
        where: { id: shipmentId },
        data: { nextPollAt: new Date(Date.now() - 1_000) },
      });
    },
    shipmentRow: (shipmentId) =>
      ctx.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } }),
    registerDevice: async (userId) => {
      await ctx.prisma.userDevice.create({
        data: {
          userId,
          platform: 'IOS',
          pushToken: `ExponentPushToken[${randomUUID()}]`,
          deviceName: 'iPhone de test',
        },
      });
    },
    makeShippedShipment: async (params) => {
      const paid = await paidOrderForUser(ctx, { locale: params.locale });
      await ctx.prisma.order.update({
        where: { id: paid.order.id },
        data: { status: 'SHIPPED', shippedAt: new Date() },
      });
      const shipment = await ctx.prisma.shipment.create({
        data: {
          orderId: paid.order.id,
          carrier: params.carrier,
          trackingNumber: params.trackingNumber,
          trackingUrl: trackingUrlFor(params.carrier, params.trackingNumber, 'fr'),
          status: 'CREATED',
          shippedAt: new Date(),
          nextPollAt: new Date(Date.now() - 1_000),
        },
      });
      return {
        orderId: paid.order.id,
        orderNumber: paid.order.number,
        userId: paid.userId,
        email: paid.email,
        accessToken: paid.accessToken,
        shipmentId: shipment.id,
        trackingNumber: params.trackingNumber,
      };
    },
  };
}

/** Bornes d'assertion sur `nextPollAt` : entre min et max minutes d'ici. */
export function expectWithinMinutes(
  date: Date | null,
  minMinutes: number,
  maxMinutes: number,
): void {
  if (!date) throw new Error('nextPollAt est null — une planification était attendue.');
  const deltaMinutes = (date.getTime() - Date.now()) / 60_000;
  if (deltaMinutes < minMinutes || deltaMinutes > maxMinutes) {
    throw new Error(
      `nextPollAt à ${deltaMinutes.toFixed(1)} min — attendu entre ${minMinutes} et ${maxMinutes} min.`,
    );
  }
}
