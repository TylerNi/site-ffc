import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATUSES } from '@ffc/core';
import {
  CANADA_POST_EVENT_STATUSES,
  canadaPostStatusFor,
} from '../src/modules/shipping/tracking/adapters/canada-post-codes';
import {
  CANPAR_EVENT_STATUSES,
  canparStatusFor,
} from '../src/modules/shipping/tracking/adapters/canpar-codes';
import {
  NATIONEX_STATUS_MAP,
  nationexStatusFor,
} from '../src/modules/shipping/tracking/adapters/nationex-codes';
import {
  PUROLATOR_SCAN_STATUSES,
  purolatorStatusFor,
} from '../src/modules/shipping/tracking/adapters/purolator-codes';
import {
  deriveStatus,
  eventDedupKey,
} from '../src/modules/shipping/tracking/tracking-ingest.service';
import {
  pollIntervalFor,
  TRACKING_DEFAULT_INTERVAL_MS,
  TRACKING_EXCEPTION_INTERVAL_MS,
  TRACKING_OUT_FOR_DELIVERY_INTERVAL_MS,
  trackingBackoffMs,
} from '../src/modules/shipping/tracking/tracking-poller.service';
import {
  dateOnlyToUtcNoon,
  easternOffsetHours,
  zonedToUtc,
} from '../src/modules/shipping/tracking/tracking-time';

/**
 * Tables de correspondance codes transporteur → statuts normalisés — le
 * cœur de la qualité de la tâche 14. Chaque table est un fichier dédié,
 * commenté ; ces tests verrouillent leur intégrité et leurs jalons clés.
 */
describe('Tables de correspondance des transporteurs (tâche 14)', () => {
  const tables = [
    { name: 'Postes Canada', table: CANADA_POST_EVENT_STATUSES, lookup: canadaPostStatusFor },
    { name: 'Nationex', table: NATIONEX_STATUS_MAP, lookup: nationexStatusFor },
    { name: 'Canpar', table: CANPAR_EVENT_STATUSES, lookup: canparStatusFor },
    { name: 'Purolator', table: PUROLATOR_SCAN_STATUSES, lookup: purolatorStatusFor },
  ] as const;

  it.each(tables)('$name : chaque code vise un statut normalisé valide', ({ table }) => {
    for (const [code, status] of Object.entries(table)) {
      expect(code.trim(), `code vide`).not.toBe('');
      expect(SHIPMENT_STATUSES, `statut de ${code}`).toContain(status);
    }
  });

  it.each(tables)('$name : couvre les jalons essentiels du cycle de vie', ({ table }) => {
    const statuses = new Set(Object.values(table));
    // Sans ces quatre-là, le suivi ne raconte pas l'histoire du colis.
    for (const essential of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']) {
      expect([...statuses], `statut ${essential}`).toContain(essential);
    }
  });

  it.each(tables)('$name : un code inconnu retourne null (jamais une erreur)', ({ lookup }) => {
    expect(lookup('CODE-QUI-N-EXISTE-PAS')).toBeNull();
    expect(lookup('')).toBeNull();
  });

  it('vérifie les jalons nominaux de chaque transporteur', () => {
    expect(canadaPostStatusFor('3000')).toBe('PICKED_UP');
    expect(canadaPostStatusFor('0174')).toBe('OUT_FOR_DELIVERY');
    expect(canadaPostStatusFor('1496')).toBe('DELIVERED');
    expect(canadaPostStatusFor('1415')).toBe('EXCEPTION');
    expect(canadaPostStatusFor('1703')).toBe('RETURNED');

    expect(nationexStatusFor('RA')).toBe('PICKED_UP');
    expect(nationexStatusFor('li')).toBe('OUT_FOR_DELIVERY'); // insensible à la casse
    expect(nationexStatusFor('LV')).toBe('DELIVERED');

    expect(canparStatusFor('PIC')).toBe('PICKED_UP');
    expect(canparStatusFor('OFD')).toBe('OUT_FOR_DELIVERY');
    expect(canparStatusFor('DEL')).toBe('DELIVERED');
    expect(canparStatusFor('RTS')).toBe('RETURNED');

    expect(purolatorStatusFor('ProofOfPickUp')).toBe('PICKED_UP');
    expect(purolatorStatusFor('OnDelivery')).toBe('OUT_FOR_DELIVERY');
    expect(purolatorStatusFor('Delivery')).toBe('DELIVERED');
    expect(purolatorStatusFor('Undeliverable')).toBe('EXCEPTION');
    // « Other » est volontairement hors table : événement informatif.
    expect(purolatorStatusFor('Other')).toBeNull();
  });
});

describe('Déduplication et statut courant (ingestion)', () => {
  const at = (iso: string): Date => new Date(iso);

  it('la clé de déduplication est stable et ignore le libellé', () => {
    const key1 = eventDedupKey({
      code: 'DEL',
      occurredAt: at('2026-07-15T18:12:33Z'),
      location: 'MONTREAL, PQ',
    });
    const key2 = eventDedupKey({
      code: 'DEL',
      occurredAt: at('2026-07-15T18:12:33Z'),
      location: 'MONTREAL, PQ',
    });
    expect(key1).toBe(key2);
    // code, horodatage ou lieu différent ⇒ clé différente.
    expect(
      eventDedupKey({
        code: 'OFD',
        occurredAt: at('2026-07-15T18:12:33Z'),
        location: 'MONTREAL, PQ',
      }),
    ).not.toBe(key1);
    expect(
      eventDedupKey({
        code: 'DEL',
        occurredAt: at('2026-07-15T18:12:34Z'),
        location: 'MONTREAL, PQ',
      }),
    ).not.toBe(key1);
    expect(
      eventDedupKey({ code: 'DEL', occurredAt: at('2026-07-15T18:12:33Z'), location: null }),
    ).not.toBe(key1);
  });

  it('le statut courant est celui de l’événement cartographié le plus récent', () => {
    expect(
      deriveStatus([
        {
          code: 'PIC',
          status: 'PICKED_UP',
          description: null,
          location: null,
          occurredAt: at('2026-07-13T21:00:00Z'),
        },
        {
          code: 'DEL',
          status: 'DELIVERED',
          description: null,
          location: null,
          occurredAt: at('2026-07-15T18:00:00Z'),
        },
        {
          code: 'OFD',
          status: 'OUT_FOR_DELIVERY',
          description: null,
          location: null,
          occurredAt: at('2026-07-15T12:00:00Z'),
        },
        // Scan administratif POSTÉRIEUR sans statut : n'influence rien.
        {
          code: 'ZZZ',
          status: null,
          description: null,
          location: null,
          occurredAt: at('2026-07-15T19:00:00Z'),
        },
      ]),
    ).toBe('DELIVERED');
  });

  it('à horodatage égal, l’événement le plus avancé l’emporte', () => {
    expect(
      deriveStatus([
        {
          code: 'A',
          status: 'OUT_FOR_DELIVERY',
          description: null,
          location: null,
          occurredAt: at('2026-07-15T12:00:00Z'),
        },
        {
          code: 'B',
          status: 'DELIVERED',
          description: null,
          location: null,
          occurredAt: at('2026-07-15T12:00:00Z'),
        },
      ]),
    ).toBe('DELIVERED');
  });

  it('aucun événement cartographié : aucun statut dérivé', () => {
    expect(deriveStatus([])).toBeNull();
    expect(
      deriveStatus([
        {
          code: 'X',
          status: null,
          description: null,
          location: null,
          occurredAt: at('2026-07-15T12:00:00Z'),
        },
      ]),
    ).toBeNull();
  });
});

describe('Cadence adaptative et recul exponentiel (poller)', () => {
  it('adapte la cadence au statut et s’arrête aux statuts finaux', () => {
    expect(pollIntervalFor('CREATED')).toBe(TRACKING_DEFAULT_INTERVAL_MS);
    expect(pollIntervalFor('PICKED_UP')).toBe(TRACKING_DEFAULT_INTERVAL_MS);
    expect(pollIntervalFor('IN_TRANSIT')).toBe(TRACKING_DEFAULT_INTERVAL_MS);
    expect(pollIntervalFor('OUT_FOR_DELIVERY')).toBe(TRACKING_OUT_FOR_DELIVERY_INTERVAL_MS);
    expect(pollIntervalFor('EXCEPTION')).toBe(TRACKING_EXCEPTION_INTERVAL_MS);
    expect(pollIntervalFor('DELIVERED')).toBeNull();
    expect(pollIntervalFor('RETURNED')).toBeNull();
  });

  it('recul exponentiel plafonné : 15 min, 30 min, 1 h… ≤ 6 h', () => {
    expect(trackingBackoffMs(1)).toBe(15 * 60_000);
    expect(trackingBackoffMs(2)).toBe(30 * 60_000);
    expect(trackingBackoffMs(3)).toBe(60 * 60_000);
    expect(trackingBackoffMs(10)).toBe(6 * 3_600_000);
  });
});

describe('Horodatages des transporteurs (tracking-time)', () => {
  it('convertit date + heure + abréviation de fuseau en UTC', () => {
    // 14:04:51 EDT (UTC-4) = 18:04:51Z
    expect(zonedToUtc('2026-07-15', '14:04:51', 'EDT')?.toISOString()).toBe(
      '2026-07-15T18:04:51.000Z',
    );
    // Hiver : EST (UTC-5).
    expect(zonedToUtc('2026-01-15', '14:04:51', 'EST')?.toISOString()).toBe(
      '2026-01-15T19:04:51.000Z',
    );
    // Terre-Neuve, demi-heure.
    expect(zonedToUtc('2026-07-15', '12:00:00', 'NDT')?.toISOString()).toBe(
      '2026-07-15T14:30:00.000Z',
    );
  });

  it('sans fuseau : heure de l’Est, avec la bascule d’heure avancée', () => {
    expect(easternOffsetHours(2026, 7, 15)).toBe(-4); // été
    expect(easternOffsetHours(2026, 1, 15)).toBe(-5); // hiver
    expect(easternOffsetHours(2026, 3, 7)).toBe(-5); // veille du 2e dimanche de mars
    expect(easternOffsetHours(2026, 3, 8)).toBe(-4); // 2e dimanche de mars 2026
    expect(easternOffsetHours(2026, 11, 1)).toBe(-5); // 1er dimanche de novembre 2026
    expect(zonedToUtc('2026-07-13', '17:15:02')?.toISOString()).toBe('2026-07-13T21:15:02.000Z');
  });

  it('une date sans heure devient midi UTC (même jour civil partout en Amérique)', () => {
    expect(dateOnlyToUtcNoon('2026-07-16')?.toISOString()).toBe('2026-07-16T12:00:00.000Z');
    expect(dateOnlyToUtcNoon(null)).toBeNull();
    expect(dateOnlyToUtcNoon('n/a')).toBeNull();
  });

  it('rejette les entrées malformées sans lever (y compris les débordements de Date.UTC)', () => {
    expect(zonedToUtc('2026-13-99', '14:00:00', 'EDT')).toBeNull();
    expect(zonedToUtc('2026-02-30', '14:00:00', 'EST')).toBeNull(); // ne roule pas au 2 mars
    expect(zonedToUtc('2026-07-15', '25:00:00', 'EDT')).toBeNull(); // ni au lendemain
    expect(zonedToUtc('2026-07-15', 'bientôt', 'EDT')).toBeNull();
  });
});
