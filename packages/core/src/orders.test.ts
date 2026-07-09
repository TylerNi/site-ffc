import { describe, expect, it } from 'vitest';
import {
  canTransitionOrder,
  CLIENT_CANCELLABLE_STATUSES,
  isClientCancellable,
  isTerminalOrderStatus,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TRANSITIONS,
  orderStatusLabel,
} from './orders';
import { ORDER_STATUSES } from './enums';

describe('machine d’états des commandes', () => {
  it('couvre chaque statut (labels + transitions)', () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_LABELS[status]).toBeDefined();
      expect(ORDER_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('autorise le chemin nominal payée → préparation → expédiée → livrée', () => {
    expect(canTransitionOrder('PAID', 'PROCESSING')).toBe(true);
    expect(canTransitionOrder('PROCESSING', 'SHIPPED')).toBe(true);
    expect(canTransitionOrder('SHIPPED', 'DELIVERED')).toBe(true);
  });

  it('refuse les sauts illégaux', () => {
    expect(canTransitionOrder('PAID', 'DELIVERED')).toBe(false);
    expect(canTransitionOrder('PAID', 'SHIPPED')).toBe(false);
    expect(canTransitionOrder('PENDING', 'PROCESSING')).toBe(false);
    // Une commande expédiée ne s'annule plus (elle se rembourse).
    expect(canTransitionOrder('SHIPPED', 'CANCELLED')).toBe(false);
    expect(canTransitionOrder('DELIVERED', 'CANCELLED')).toBe(false);
  });

  it('permet l’annulation client seulement avant expédition', () => {
    expect(isClientCancellable('PAID')).toBe(true);
    expect(isClientCancellable('PROCESSING')).toBe(true);
    expect(isClientCancellable('SHIPPED')).toBe(false);
    expect(isClientCancellable('PENDING')).toBe(false);
    expect(CLIENT_CANCELLABLE_STATUSES).toEqual(['PAID', 'PROCESSING']);
  });

  it('autorise remboursement total et partiel depuis les états payés', () => {
    for (const from of ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const) {
      expect(canTransitionOrder(from, 'REFUNDED')).toBe(true);
      expect(canTransitionOrder(from, 'PARTIALLY_REFUNDED')).toBe(true);
    }
    // Plusieurs remboursements partiels successifs, puis total.
    expect(canTransitionOrder('PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED')).toBe(true);
    expect(canTransitionOrder('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
  });

  it('marque CANCELLED et REFUNDED comme terminaux', () => {
    expect(isTerminalOrderStatus('CANCELLED')).toBe(true);
    expect(isTerminalOrderStatus('REFUNDED')).toBe(true);
    expect(isTerminalOrderStatus('PAID')).toBe(false);
  });

  it('localise les libellés', () => {
    expect(orderStatusLabel('SHIPPED', 'fr')).toBe('Expédiée');
    expect(orderStatusLabel('SHIPPED', 'en')).toBe('Shipped');
  });
});
