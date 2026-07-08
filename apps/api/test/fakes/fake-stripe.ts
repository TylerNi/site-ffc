import { ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { type CreatePaymentIntentParams } from '../../src/modules/orders/stripe/stripe.service';

/** Secret de signature utilisé par le faux (et pour signer les rejeux). */
export const TEST_WEBHOOK_SECRET = 'whsec_test_ffc_signature';

/**
 * Faux Stripe EN MÉMOIRE pour les e2e — même surface que StripeService.
 *
 * Ce qui est simulé : cycle de vie des PaymentIntents (création, mise à
 * jour tant que payable, confirmation succès/refus/3DS), charges avec
 * marque/last4/URL de reçu, remboursements.
 *
 * Ce qui reste RÉEL : la vérification de signature des webhooks
 * (`stripe.webhooks.constructEvent`, crypto pure du SDK, aucun réseau) —
 * les tests signent leurs payloads avec generateTestHeaderString et le
 * contrôleur exécute exactement le code de production.
 */
export class FakeStripeService {
  private readonly sdk = new Stripe('sk_test_fake_hors_reseau', { typescript: true });
  private sequence = 0;
  /**
   * Préfixe d'instance : la base de test est PARTAGÉE entre fichiers
   * exécutés en parallèle et payments/refunds/webhook_events portent des
   * contraintes d'unicité sur les identifiants externes — chaque faux
   * Stripe fabrique donc des identifiants globalement uniques.
   */
  private readonly runId = Math.random().toString(36).slice(2, 8);

  readonly intents = new Map<string, Stripe.PaymentIntent>();
  readonly charges = new Map<string, Stripe.Charge>();
  readonly refunds = new Map<string, Stripe.Refund>();

  isConfigured(): boolean {
    return true;
  }

  /* ------------------------- Surface StripeService ----------------------- */

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<Stripe.PaymentIntent> {
    this.sequence += 1;
    const id = `pi_test_${this.runId}_${String(this.sequence).padStart(6, '0')}`;
    const intent = {
      id,
      object: 'payment_intent',
      amount: params.amountCents,
      currency: params.currency,
      status: 'requires_payment_method',
      client_secret: `${id}_secret_${Math.random().toString(36).slice(2, 12)}`,
      metadata: { ...params.metadata },
      receipt_email: params.receiptEmail ?? null,
      latest_charge: null,
      last_payment_error: null,
    } as unknown as Stripe.PaymentIntent;
    this.intents.set(id, intent);
    return structuredClone(intent);
  }

  async updatePaymentIntent(
    id: string,
    params: Pick<CreatePaymentIntentParams, 'amountCents' | 'metadata' | 'receiptEmail'>,
  ): Promise<Stripe.PaymentIntent> {
    const intent = this.require(id);
    if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation') {
      throw new Error(
        `You cannot update the amount of a PaymentIntent with status ${intent.status}.`,
      );
    }
    intent.amount = params.amountCents;
    intent.metadata = { ...params.metadata };
    (intent as { receipt_email: string | null }).receipt_email = params.receiptEmail ?? null;
    return structuredClone(intent);
  }

  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
    return structuredClone(this.require(id));
  }

  async listRefundsForCharge(chargeId: string): Promise<Stripe.Refund[]> {
    return [...this.refunds.values()]
      .filter((refund) => refund.charge === chargeId)
      .map((refund) => structuredClone(refund));
  }

  async createRefund(paymentIntentId: string, reason: string): Promise<Stripe.Refund> {
    const intent = this.require(paymentIntentId);
    const charge =
      intent.latest_charge && typeof intent.latest_charge === 'object'
        ? this.charges.get(intent.latest_charge.id)
        : null;
    if (!charge) throw new Error(`No charge to refund on ${paymentIntentId}`);

    this.sequence += 1;
    const refund = {
      id: `re_test_${this.runId}_${String(this.sequence).padStart(6, '0')}`,
      object: 'refund',
      amount: charge.amount - charge.amount_refunded,
      charge: charge.id,
      payment_intent: paymentIntentId,
      currency: charge.currency,
      status: 'succeeded',
      reason: null,
      metadata: { reason },
    } as unknown as Stripe.Refund;
    this.refunds.set(refund.id, refund);
    charge.amount_refunded = charge.amount;
    (charge as { refunded: boolean }).refunded = true;
    return structuredClone(refund);
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.sdk.webhooks.constructEvent(rawBody, signature, TEST_WEBHOOK_SECRET);
  }

  /* --------------------------- Aides de test ----------------------------- */

  private require(id: string): Stripe.PaymentIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new ServiceUnavailableException(`No such payment_intent: '${id}'`);
    }
    return intent;
  }

  /**
   * Simule la confirmation côté client (Payment Element) :
   *   success — carte 4242… : charge créée, intent `succeeded` ;
   *   declined — carte 4000…0002 : `requires_payment_method` + erreur ;
   *   requires_action — carte 3DS 4000…3155 : défi en attente.
   */
  confirm(id: string, outcome: 'success' | 'declined' | 'requires_action'): void {
    const intent = this.require(id);
    if (outcome === 'success') {
      this.attachSucceededCharge(intent);
      return;
    }
    if (outcome === 'requires_action') {
      intent.status = 'requires_action';
      return;
    }
    intent.status = 'requires_payment_method';
    (intent as { last_payment_error: unknown }).last_payment_error = {
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
    };
  }

  /** Complète le défi 3DS d'un intent `requires_action`. */
  completeAction(id: string): void {
    const intent = this.require(id);
    if (intent.status !== 'requires_action') {
      throw new Error(`completeAction: intent ${id} est « ${intent.status} »`);
    }
    this.attachSucceededCharge(intent);
  }

  private attachSucceededCharge(intent: Stripe.PaymentIntent): void {
    this.sequence += 1;
    const charge = {
      id: `ch_test_${this.runId}_${String(this.sequence).padStart(6, '0')}`,
      object: 'charge',
      amount: intent.amount,
      amount_captured: intent.amount,
      amount_refunded: 0,
      currency: intent.currency,
      payment_intent: intent.id,
      refunded: false,
      receipt_url: `https://pay.stripe.com/receipts/test/${intent.id}`,
      payment_method_details: {
        type: 'card',
        card: { brand: 'visa', last4: '4242' },
      },
    } as unknown as Stripe.Charge;
    this.charges.set(charge.id, charge);
    intent.status = 'succeeded';
    (intent as { latest_charge: Stripe.Charge }).latest_charge = charge;
    (intent as { last_payment_error: null }).last_payment_error = null;
  }

  /**
   * Payload signé d'un événement webhook — la signature est produite par le
   * SDK réel : le contrôleur vérifie EXACTEMENT comme en production.
   * `eventId` stable ⇒ rejouer le même événement (test d'idempotence).
   */
  signedEvent(
    type: string,
    object: unknown,
    eventId?: string,
    secret: string = TEST_WEBHOOK_SECRET,
  ): { payload: string; signature: string; eventId: string } {
    this.sequence += 1;
    const id = eventId ?? `evt_test_${this.runId}_${String(this.sequence).padStart(6, '0')}`;
    const payload = JSON.stringify({
      id,
      object: 'event',
      api_version: '2025-02-24',
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object },
      livemode: false,
      pending_webhooks: 1,
    });
    const signature = this.sdk.webhooks.generateTestHeaderString({ payload, secret });
    return { payload, signature, eventId: id };
  }

  /** Intent brut (sans clone) — inspection directe dans les assertions. */
  peek(id: string): Stripe.PaymentIntent {
    return this.require(id);
  }
}
