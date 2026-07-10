import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CanadaPostTracker } from '../src/modules/shipping/tracking/adapters/canada-post.tracker';
import { CanparTracker } from '../src/modules/shipping/tracking/adapters/canpar.tracker';
import { NationexTracker } from '../src/modules/shipping/tracking/adapters/nationex.tracker';
import { PurolatorTracker } from '../src/modules/shipping/tracking/adapters/purolator.tracker';
import { CarrierTrackingError } from '../src/modules/shipping/tracking/carrier-tracker';
import { type TrackingHttp } from '../src/modules/shipping/tracking/tracking-http';
import { type Env } from '../src/config/env';
import { FakeTrackingHttp } from './fakes/fake-tracking-http';
import { trackingFixture } from './tracking-helpers';

/**
 * Adapters de repérage sur FIXTURES (réponses réelles anonymisées) : chaque
 * adapter est instancié tel quel — authentification, construction d'URL,
 * parsing XML/JSON/SOAP, fuseaux — seul le fil réseau est un faux.
 */

const BASE_ENV: Partial<Env> = {
  CANADA_POST_BASE_URL: 'https://soa-gw.canadapost.ca',
  NATIONEX_BASE_URL: 'https://api.nationex.com',
  CANPAR_BASE_URL: 'https://canship.canpar.com',
  PUROLATOR_BASE_URL: 'https://webservices.purolator.com',
  CANADA_POST_API_USERNAME: 'cpc-user',
  CANADA_POST_API_PASSWORD: 'cpc-pass',
  NATIONEX_CUSTOMER_ID: '104200',
  NATIONEX_API_KEY: 'nx-key',
  CANPAR_API_USERNAME: 'canpar-user',
  CANPAR_API_PASSWORD: 'canpar-pass',
  PUROLATOR_API_KEY: 'puro-key',
  PUROLATOR_API_PASSWORD: 'puro-pass',
};

function fakeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = { ...BASE_ENV, ...overrides };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

function makeAll(http: FakeTrackingHttp, overrides: Partial<Env> = {}) {
  const transport = http as unknown as TrackingHttp;
  const config = fakeConfig(overrides);
  return {
    canadaPost: new CanadaPostTracker(transport, config),
    nationex: new NationexTracker(transport, config),
    canpar: new CanparTracker(transport, config),
    purolator: new PurolatorTracker(transport, config),
  };
}

describe('Adapter Postes Canada', () => {
  it('parse une chronologie complète : codes, statuts, lieux, fuseaux, ETA', async () => {
    const http = new FakeTrackingHttp();
    const { canadaPost } = makeAll(http);
    http.stage('CANADA_POST', trackingFixture('CANADA_POST', '04-delivered.xml'));

    const result = await canadaPost.track('7023210039414604');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.events).toHaveLength(4);
    const delivered = result.events.find((event) => event.code === '1496')!;
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.description).toBe('Item successfully delivered');
    expect(delivered.location).toBe('MONTREAL, QC');
    // 14:04:51 EDT = 18:04:51 UTC.
    expect(delivered.occurredAt.toISOString()).toBe('2026-07-15T18:04:51.000Z');
    // ETA à midi UTC (même jour civil dans tous les fuseaux nord-américains).
    expect(result.estimatedDeliveryAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z');

    // L'appel est authentifié (Basic) et vise le bon endpoint.
    const call = http.callsFor('CANADA_POST')[0]!;
    expect(call.url).toBe('https://soa-gw.canadapost.ca/vis/track/pin/7023210039414604/detail');
    expect(call.headers?.authorization).toMatch(/^Basic /);
    expect(call.headers?.accept).toContain('track-v2+xml');
  });

  it('« No Pin History » (message 004) = numéro inconnu, pas une erreur', async () => {
    const http = new FakeTrackingHttp();
    const { canadaPost } = makeAll(http);
    http.stage('CANADA_POST', trackingFixture('CANADA_POST', 'not-found.xml'), 404);
    expect((await canadaPost.track('7023210039414604')).kind).toBe('not_found');
  });

  it('classe les erreurs : 500 retentable, 401 définitive', async () => {
    const http = new FakeTrackingHttp();
    const { canadaPost } = makeAll(http);

    http.stage('CANADA_POST', 'Internal Server Error', 500);
    await expect(canadaPost.track('X')).rejects.toSatisfy(
      (error: unknown) => error instanceof CarrierTrackingError && error.retryable,
    );

    http.stage('CANADA_POST', 'Unauthorized', 401);
    await expect(canadaPost.track('X')).rejects.toSatisfy(
      (error: unknown) => error instanceof CarrierTrackingError && !error.retryable,
    );
  });

  it('sans clés : non configuré', () => {
    const { canadaPost } = makeAll(new FakeTrackingHttp(), {
      CANADA_POST_API_USERNAME: undefined,
      CANADA_POST_API_PASSWORD: undefined,
    });
    expect(canadaPost.isConfigured()).toBe(false);
  });
});

describe('Adapter Nationex', () => {
  it('parse le JSON v4 : codes courts, horodatages ISO avec décalage, ETA', async () => {
    const http = new FakeTrackingHttp();
    const { nationex } = makeAll(http);
    http.stage('NATIONEX', trackingFixture('NATIONEX', '04-delivered.json'));

    const result = await nationex.track('NX100200300');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.events).toHaveLength(5);
    const delivered = result.events.find((event) => event.code === 'LV')!;
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.occurredAt.toISOString()).toBe('2026-07-15T17:44:09.000Z');
    expect(delivered.location).toBe('Montréal, QC');
    // Le code « SC » (tri divers) n'est pas cartographié : conservé, statut null.
    expect(result.events.find((event) => event.code === 'SC')!.status).toBeNull();
    expect(result.estimatedDeliveryAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z');

    const call = http.callsFor('NATIONEX')[0]!;
    expect(call.url).toBe('https://api.nationex.com/api/v4/Shipments/NX100200300/tracking');
    expect(call.headers?.authorization).toMatch(/^Basic /);
  });

  it('404 = expédition encore inconnue (normal au début)', async () => {
    const http = new FakeTrackingHttp();
    const { nationex } = makeAll(http);
    http.stage('NATIONEX', '{"message":"Shipment not found"}', 404);
    expect((await nationex.track('NX1')).kind).toBe('not_found');
  });
});

describe('Adapter Canpar', () => {
  it('parse le SOAP trackByBarcodeV2 : heures locales de l’Est, adresses', async () => {
    const http = new FakeTrackingHttp();
    const { canpar } = makeAll(http);
    http.stage('CANPAR', trackingFixture('CANPAR', '04-delivered.xml'));

    const result = await canpar.track('D420001122334455');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.events).toHaveLength(5);
    const delivered = result.events.find((event) => event.code === 'DEL')!;
    expect(delivered.status).toBe('DELIVERED');
    // « 20260715 141233 » (heure de l'Est, été) = 18:12:33 UTC.
    expect(delivered.occurredAt.toISOString()).toBe('2026-07-15T18:12:33.000Z');
    expect(delivered.location).toBe('MONTREAL, PQ');

    // La requête embarque l'authentification dans le corps SOAP.
    const call = http.callsFor('CANPAR')[0]!;
    expect(call.method).toBe('POST');
    expect(call.body).toContain('<xsd:user_id>canpar-user</xsd:user_id>');
    expect(call.body).toContain('<xsd:barcode>D420001122334455</xsd:barcode>');
  });

  it('« NO SHIPMENT FOUND » = numéro inconnu, pas une erreur', async () => {
    const http = new FakeTrackingHttp();
    const { canpar } = makeAll(http);
    http.stage('CANPAR', trackingFixture('CANPAR', 'not-found.xml'));
    expect((await canpar.track('D42000')).kind).toBe('not_found');
  });
});

describe('Adapter Purolator', () => {
  it('parse le SOAP TrackPackagesByPin : ScanType, dépôts, heures locales', async () => {
    const http = new FakeTrackingHttp();
    const { purolator } = makeAll(http);
    http.stage('PUROLATOR', trackingFixture('PUROLATOR', '04-delivered.xml'));

    const result = await purolator.track('331200000001');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.events).toHaveLength(4);
    const delivered = result.events.find((event) => event.code === 'Delivery')!;
    expect(delivered.status).toBe('DELIVERED');
    // « 2026-07-15 135940 » (heure de l'Est, été) = 17:59:40 UTC.
    expect(delivered.occurredAt.toISOString()).toBe('2026-07-15T17:59:40.000Z');
    expect(delivered.location).toBe('Montreal Metro QC');
    expect(delivered.description).toContain('delivered');

    const call = http.callsFor('PUROLATOR')[0]!;
    expect(call.headers?.soapaction).toContain('TrackPackagesByPin');
    expect(call.headers?.authorization).toMatch(/^Basic /);
    expect(call.body).toContain('<v1:Value>331200000001</v1:Value>');
  });

  it('liste de repérage vide = PIN encore inconnu', async () => {
    const http = new FakeTrackingHttp();
    const { purolator } = makeAll(http);
    http.stage('PUROLATOR', trackingFixture('PUROLATOR', 'not-found.xml'));
    expect((await purolator.track('331200000001')).kind).toBe('not_found');
  });

  it('les scans « Other » sont conservés sans statut', async () => {
    const http = new FakeTrackingHttp();
    const { purolator } = makeAll(http);
    http.stage('PUROLATOR', trackingFixture('PUROLATOR', '02-in-transit.xml'));

    const result = await purolator.track('331200000001');
    if (result.kind !== 'ok') throw new Error('ok attendu');
    const other = result.events.find((event) => event.code === 'Other')!;
    expect(other.status).toBeNull();
    expect(other.description).toBe('Shipment weight recorded');
  });

  it('sans accès API (tâche 01) : non configuré', () => {
    const { purolator } = makeAll(new FakeTrackingHttp(), {
      PUROLATOR_API_KEY: undefined,
      PUROLATOR_API_PASSWORD: undefined,
    });
    expect(purolator.isConfigured()).toBe(false);
  });
});
