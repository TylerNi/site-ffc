import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { type Env } from '../../../config/env';

export interface CreatePaymentIntentParams {
  amountCents: number;
  currency: 'cad' | 'usd';
  metadata: Record<string, string>;
  /** Courriel du payeur (reçus Stripe en mode test/production). */
  receiptEmail?: string;
}

/**
 * Enveloppe mince et INJECTABLE du SDK Stripe — la seule porte vers Stripe.
 *
 * Périmètre PCI SAQ A : ce service ne voit JAMAIS de numéro de carte ;
 * il crée des PaymentIntents (montants calculés côté serveur), consulte
 * leur état, émet des remboursements et vérifie la signature des webhooks.
 * La saisie de carte vit exclusivement dans le Payment Element (iframe
 * Stripe) côté navigateur.
 *
 * Sans STRIPE_SECRET_KEY (dev sans clés) : les méthodes réseau répondent
 * 503 avec un message clair ; le reste de l'API fonctionne normalement.
 * Les tests substituent ce provider par un faux en mémoire.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: Stripe;
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(config: ConfigService<Env, true>) {
    this.secretKey = config.get('STRIPE_SECRET_KEY', { infer: true });
    this.webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
    // Une clé factice suffit pour les opérations HORS réseau (vérification
    // de signature) ; requireConfigured() garde toutes les opérations réseau.
    this.client = new Stripe(this.secretKey ?? 'sk_test_cle_absente_hors_reseau_seulement', {
      typescript: true,
    });
    if (!this.secretKey) {
      this.logger.warn('STRIPE_SECRET_KEY absente — checkout désactivé (503).');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  private requireConfigured(): void {
    if (!this.secretKey) {
      throw new ServiceUnavailableException(
        'Paiements indisponibles : Stripe n’est pas configuré sur ce serveur.',
      );
    }
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<Stripe.PaymentIntent> {
    this.requireConfigured();
    return this.client.paymentIntents.create({
      amount: params.amountCents,
      currency: params.currency,
      // Cartes + Apple Pay + Google Pay + 3DS automatique, sans liste à
      // maintenir : Stripe active les méthodes pertinentes du Dashboard.
      automatic_payment_methods: { enabled: true },
      metadata: params.metadata,
      receipt_email: params.receiptEmail,
    });
  }

  /** Met à jour montant/metadata d'un intent encore confirmable. */
  async updatePaymentIntent(
    id: string,
    params: Pick<CreatePaymentIntentParams, 'amountCents' | 'metadata' | 'receiptEmail'>,
  ): Promise<Stripe.PaymentIntent> {
    this.requireConfigured();
    return this.client.paymentIntents.update(id, {
      amount: params.amountCents,
      metadata: params.metadata,
      receipt_email: params.receiptEmail,
    });
  }

  /** Intent + charge dépliée (marque de carte, last4, URL de reçu). */
  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
    this.requireConfigured();
    return this.client.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
  }

  /**
   * Remboursements d'une charge — repli du webhook `charge.refunded` : les
   * versions récentes de l'API n'embarquent plus la liste dans le payload.
   */
  async listRefundsForCharge(chargeId: string): Promise<Stripe.Refund[]> {
    this.requireConfigured();
    const page = await this.client.refunds.list({ charge: chargeId, limit: 100 });
    return page.data;
  }

  /**
   * Remboursement d'un PaymentIntent — intégral (montant omis) ou PARTIEL
   * (`amountCents`). La clé d'idempotence Stripe rend un rejeu inoffensif :
   * Stripe renvoie le MÊME remboursement plutôt que d'en créer un second.
   */
  async createRefund(params: {
    paymentIntentId: string;
    reason: string;
    amountCents?: number;
    idempotencyKey?: string;
  }): Promise<Stripe.Refund> {
    this.requireConfigured();
    return this.client.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        ...(params.amountCents !== undefined ? { amount: params.amountCents } : {}),
        metadata: { reason: params.reason },
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
  }

  /**
   * Vérifie la SIGNATURE du webhook et reconstruit l'événement — rejette
   * tout corps altéré ou non signé par notre secret d'endpoint.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException(
        'Webhooks indisponibles : STRIPE_WEBHOOK_SECRET n’est pas configuré.',
      );
    }
    return this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
