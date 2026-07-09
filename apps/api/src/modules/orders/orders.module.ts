import { Module } from '@nestjs/common';
import { CartController } from './cart/cart.controller';
import { CartService } from './cart/cart.service';
import { CheckoutController } from './checkout/checkout.controller';
import { CheckoutPricingService } from './checkout/checkout-pricing.service';
import { CheckoutService } from './checkout/checkout.service';
import { CouponService } from './checkout/coupon.service';
import { ShippingService } from './checkout/shipping.service';
import { taxCalculatorProvider } from './checkout/tax.provider';
import { CustomerOrdersController } from './customer/customer-orders.controller';
import { CustomerOrdersService } from './customer/customer-orders.service';
import { OrderFinalizerService } from './finalize/order-finalizer.service';
import { CompanyInfoService } from './invoices/company-info';
import { InvoiceDownloadController } from './invoices/invoice-download.controller';
import { InvoiceDownloadTokenService } from './invoices/invoice-download-token';
import { InvoiceQueueService } from './invoices/invoice-queue.service';
import { InvoiceService } from './invoices/invoice.service';
import { invoiceStorageProvider } from './invoices/invoice-storage';
import { OrderMailService } from './invoices/order-mail.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { RefundService } from './refunds/refund.service';
import { StripeService } from './stripe/stripe.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookProcessorService } from './webhooks/stripe-webhook-processor.service';
import { WebhookQueueService } from './webhooks/webhook-queue.service';

/**
 * Panier + checkout Stripe (tâche 11) ET cycle de vie post-paiement (tâche 12) :
 * machine d'états des commandes, factures PDF bilingues, remboursements,
 * courriels transactionnels et espace « Mes commandes ».
 *
 * Périmètre PCI SAQ A : la carte ne transite QUE par le Payment Element
 * (iframe Stripe) côté client ; l'API ne manipule que des identifiants
 * opaques (PaymentIntent, charge) et les 4 derniers chiffres du reçu.
 */
@Module({
  controllers: [
    CartController,
    CheckoutController,
    StripeWebhookController,
    CustomerOrdersController,
    InvoiceDownloadController,
  ],
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
    // Tâche 12
    CompanyInfoService,
    invoiceStorageProvider,
    InvoiceDownloadTokenService,
    OrderMailService,
    InvoiceService,
    InvoiceQueueService,
    RefundService,
    OrderLifecycleService,
    CustomerOrdersService,
  ],
  exports: [
    CartService,
    StripeWebhookProcessorService,
    // Prêts pour les tâches 13 (ShipStation), 14 (suivi) et 22 (admin).
    OrderLifecycleService,
    RefundService,
    InvoiceService,
    InvoiceQueueService,
  ],
})
export class OrdersModule {}
