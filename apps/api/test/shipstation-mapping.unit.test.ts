import { describe, expect, it } from 'vitest';
import { carrierLabel, normalizeCarrierCode, trackingUrlFor } from '@ffc/core';
import {
  buildOrderPayload,
  DEFAULT_UNIT_WEIGHT_GRAMS,
  internalNotesFor,
  type MappedOrder,
  totalWeightGrams,
} from '../src/modules/shipping/shipstation/shipstation-mapper';
import {
  backoffDelayMs,
  SHIPSTATION_BACKOFF_BASE_MS,
  SHIPSTATION_BACKOFF_MAX_MS,
} from '../src/modules/shipping/shipstation/shipstation-outbox';

/** Commande de référence : QC, deux articles, taxes ventilées. */
function orderFixture(overrides: Partial<MappedOrder> = {}): MappedOrder {
  return {
    id: '0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
    number: 'FFC-100042',
    locale: 'fr',
    paidAt: new Date('2026-07-09T14:30:00.000Z'),
    placedAt: new Date('2026-07-09T14:28:00.000Z'),
    customerEmail: 'client@example.com',
    shippingAddress: {
      firstName: 'Marie',
      lastName: 'Tremblay',
      company: null,
      line1: '1234, rue Sainte-Catherine Est',
      line2: 'App. 3',
      city: 'Montréal',
      province: 'QC',
      postalCode: 'H2L 2G8',
      country: 'CA',
      phone: '514-555-0142',
    },
    billingAddress: null,
    items: [
      {
        id: 'item-1',
        sku: 'FFC-16251-M11',
        nameFr: 'Filtre 16x25x1 MERV 11',
        nameEn: '16x25x1 MERV 11 filter',
        quantity: 2,
        unitPriceCents: 2_499,
        taxCents: 748,
        weightGrams: 620,
      },
      {
        id: 'item-2',
        sku: 'FFC-20251-M13',
        nameFr: 'Filtre 20x25x1 MERV 13',
        nameEn: '20x25x1 MERV 13 filter',
        quantity: 1,
        unitPriceCents: 3_199,
        taxCents: 479,
        weightGrams: null,
      },
    ],
    discountCents: 0,
    shippingCents: 0,
    totalTaxCents: 1_227,
    totalCents: 9_424,
    customerNote: 'Sonner chez le voisin',
    ...overrides,
  };
}

describe('ShipStation — normalisation des transporteurs', () => {
  it('ramène les codes ShipStation vers notre enum, quelle que soit leur graphie', () => {
    expect(normalizeCarrierCode('canada_post')).toBe('CANADA_POST');
    expect(normalizeCarrierCode('CanadaPost')).toBe('CANADA_POST');
    expect(normalizeCarrierCode('Canada Post')).toBe('CANADA_POST');
    expect(normalizeCarrierCode('postes_canada')).toBe('CANADA_POST');
    expect(normalizeCarrierCode('purolator')).toBe('PUROLATOR');
    expect(normalizeCarrierCode('purolator_ground')).toBe('PUROLATOR');
    expect(normalizeCarrierCode('canpar')).toBe('CANPAR');
    expect(normalizeCarrierCode('nationex')).toBe('NATIONEX');
  });

  it('ne lève jamais : un transporteur inconnu devient OTHER', () => {
    expect(normalizeCarrierCode('ups')).toBe('OTHER');
    expect(normalizeCarrierCode('')).toBe('OTHER');
    expect(normalizeCarrierCode(null)).toBe('OTHER');
    expect(normalizeCarrierCode(undefined)).toBe('OTHER');
  });

  it('construit un lien de repérage par transporteur et par langue', () => {
    expect(trackingUrlFor('CANADA_POST', '1234567890', 'fr')).toContain(
      'canadapost-postescanada.ca/track-reperage/fr',
    );
    expect(trackingUrlFor('CANADA_POST', '1234567890', 'en')).toContain('/track-reperage/en');
    expect(trackingUrlFor('PUROLATOR', 'ABC 123', 'en')).toBe(
      'https://www.purolator.com/en/shipping/tracker?pins=ABC%20123',
    );
    // Transporteur inconnu ou suivi absent : pas de lien (le courriel l'omet).
    expect(trackingUrlFor('OTHER', '123')).toBeNull();
    expect(trackingUrlFor('CANPAR', null)).toBeNull();
  });

  it('donne des libellés bilingues', () => {
    expect(carrierLabel('CANADA_POST', 'fr')).toBe('Postes Canada');
    expect(carrierLabel('CANADA_POST', 'en')).toBe('Canada Post');
  });
});

describe('ShipStation — mapping des commandes', () => {
  it('utilise notre numéro de commande comme référence externe (orderNumber ET orderKey)', () => {
    const payload = buildOrderPayload(orderFixture());
    expect(payload.orderNumber).toBe('FFC-100042');
    expect(payload.orderKey).toBe('FFC-100042');
    // L'UUID voyage en champ personnalisé : le retour d'expédition le retrouve.
    expect(payload.advancedOptions.customField1).toBe('0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b');
    expect(payload.orderStatus).toBe('awaiting_shipment');
  });

  it('convertit les cents en dollars et ventile les montants', () => {
    const payload = buildOrderPayload(orderFixture());
    expect(payload.amountPaid).toBe(94.24);
    expect(payload.taxAmount).toBe(12.27);
    expect(payload.shippingAmount).toBe(0);
    expect(payload.items[0]!.unitPrice).toBe(24.99);
    expect(payload.items[0]!.taxAmount).toBe(7.48);
  });

  it('copie l’adresse de livraison et retombe sur elle pour la facturation', () => {
    const payload = buildOrderPayload(orderFixture());
    expect(payload.shipTo).toMatchObject({
      name: 'Marie Tremblay',
      street1: '1234, rue Sainte-Catherine Est',
      street2: 'App. 3',
      city: 'Montréal',
      state: 'QC',
      postalCode: 'H2L 2G8',
      country: 'CA',
      phone: '514-555-0142',
    });
    expect(payload.billTo).toEqual(payload.shipTo);
  });

  it('nomme les articles dans la langue du client', () => {
    expect(buildOrderPayload(orderFixture()).items[0]!.name).toBe('Filtre 16x25x1 MERV 11');
    expect(buildOrderPayload(orderFixture({ locale: 'en' })).items[0]!.name).toBe(
      '16x25x1 MERV 11 filter',
    );
  });

  it('présume un poids par défaut quand la variante n’en déclare pas, et le signale', () => {
    const order = orderFixture();
    expect(totalWeightGrams(order.items)).toBe(620 * 2 + DEFAULT_UNIT_WEIGHT_GRAMS);
    expect(internalNotesFor(order)).toContain('Poids manquant');
  });

  it('signale la livraison aux États-Unis à l’équipe d’expédition', () => {
    const order = orderFixture({
      shippingAddress: {
        firstName: 'John',
        lastName: 'Doe',
        line1: '1 Main St',
        city: 'Buffalo',
        province: 'NY',
        postalCode: '14201',
        country: 'US',
      },
      items: [{ ...orderFixture().items[0]!, weightGrams: 620 }],
      discountCents: 500,
    });
    const notes = internalNotesFor(order);
    expect(notes).toContain('LIVRAISON ÉTATS-UNIS');
    expect(notes).toContain('Remise appliquée : 5.00 $ CA');
    expect(notes).not.toContain('Poids manquant');
  });

  it('passe l’identifiant ShipStation et le statut « cancelled » lors d’une annulation', () => {
    const payload = buildOrderPayload(orderFixture(), {
      status: 'cancelled',
      shipstationOrderId: 4242,
      storeId: 7,
    });
    expect(payload.orderId).toBe(4242);
    expect(payload.orderStatus).toBe('cancelled');
    expect(payload.advancedOptions.storeId).toBe(7);
  });
});

describe('ShipStation — recul exponentiel', () => {
  it('double à chaque tentative puis plafonne', () => {
    expect(backoffDelayMs(1)).toBe(SHIPSTATION_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(SHIPSTATION_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(SHIPSTATION_BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(20)).toBe(SHIPSTATION_BACKOFF_MAX_MS);
  });
});
