import { Module } from '@nestjs/common';
import { CartController } from './cart/cart.controller';
import { CartService } from './cart/cart.service';
import { CheckoutController } from './checkout/checkout.controller';
import { CheckoutPricingService } from './checkout/checkout-pricing.service';
import { CheckoutService } from './checkout/checkout.service';
import { CouponService } from './checkout/coupon.service';
import { ShippingService } from './checkout/shipping.service';
import { taxCalculatorProvider } from './checkout/tax.provider';
import { OrderFinalizerService } from './finalize/order-finalizer.service';
import { StripeService } from './stripe/stripe.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookProcessorService } from './webhooks/stripe-webhook-processor.service';
import { WebhookQueueService } from './webhooks/webhook-queue.service';

/**
 * Panier et checkout Stripe (tâche 11) ; le cycle de vie post-paiement
 * (factures, courriels riches) arrive à la tâche 12.
 *
 * Périmètre PCI SAQ A : la carte ne transite QUE par le Payment Element
 * (iframe Stripe) côté client ; l'API ne manipule que des identifiants
 * opaques (PaymentIntent, charge) et les 4 derniers chiffres remis par
 * Stripe pour les reçus.
 */
@Module({
  controllers: [CartController, CheckoutController, StripeWebhookController],
  providers: [
    CartService,
    CheckoutService,
    CheckoutPricingService,
    CouponService,
    ShippingService,
    taxCalculatorProvider,
    StripeService,
    OrderFinalizerService,
    StripeWebhookProcessorService,
    WebhookQueueService,
  ],
  exports: [CartService, StripeWebhookProcessorService],
})
export class OrdersModule {}
