import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type Locale, type Order, type OrderItem, Prisma, type User } from '@prisma/client';
import { type CheckoutAddress, checkoutAddressSchema } from '@ffc/core';
import type Stripe from 'stripe';
import { z } from 'zod';
import { PrismaService } from '../../../database';
import { allocateOrderNumber } from '../../../database/order-number';
import { CartService, type CartOwner } from '../cart/cart.service';
import { type CartDto } from '../cart/dto/cart.dto';
import { OrderFinalizerService } from '../finalize/order-finalizer.service';
import { StripeService } from '../stripe/stripe.service';
import { CheckoutPricingService, type CheckoutQuote } from './checkout-pricing.service';
import { CouponService } from './coupon.service';
import {
  type CheckoutAddressDto,
  type CheckoutResultDto,
  type CheckoutSessionDto,
  type CreateCheckoutSessionDto,
  type OrderSummaryDto,
} from './dto/checkout.dto';

const emailSchema = z.email().max(254);

type OrderWithItems = Order & {
  items: OrderItem[];
  coupon: { code: string } | null;
  user?: { email: string } | null;
};

/**
 * Checkout Stripe (tâche 11) — création de session de paiement.
 *
 * Principes non négociables :
 *   - le MONTANT de l'intent sort de la cotation serveur (panier revalidé,
 *     taxes, livraison) — jamais du client ;
 *   - une commande PENDING est créée/actualisée AVANT le paiement : c'est
 *     elle que référencent les metadata de l'intent (`orderId`, `number`) ;
 *   - re-soumettre le checkout (adresse ou coupon modifiés) RECOTE la même
 *     commande et met à jour le même PaymentIntent tant qu'il est payable ;
 *   - la finalisation (stock, coupon, statut payé) vit dans
 *     OrderFinalizerService, déclenchée par webhook OU par le retour client
 *     — idempotente dans les deux sens.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly carts: CartService,
    private readonly coupons: CouponService,
    private readonly pricing: CheckoutPricingService,
    private readonly stripe: StripeService,
    private readonly finalizer: OrderFinalizerService,
  ) {}

  /* ------------------------------- Session ------------------------------ */

  async createSession(
    owner: CartOwner,
    user: User | null,
    dto: CreateCheckoutSessionDto,
    network: { ip: string | null; userAgent: string | null },
  ): Promise<CheckoutSessionDto> {
    const cart = await this.carts.findActiveCart(owner);
    if (!cart)
      throw new BadRequestException({ code: 'CART_EMPTY', message: 'Le panier est vide.' });

    // Revalidation totale : les écarts bloquent la cotation — le client
    // réaffiche le panier avec les messages, puis re-soumet.
    const view = await this.carts.reconcile(cart.id);
    this.assertCartClean(view);

    const email = this.resolveEmail(user, dto.email);
    const locale: Locale = dto.locale ?? user?.locale ?? 'fr';
    const shippingAddress = await this.resolveShippingAddress(user, dto);
    const billingAddress = dto.billingAddress
      ? this.parseAddress(dto.billingAddress, 'billingAddress')
      : shippingAddress;

    const coupon = dto.couponCode
      ? await this.coupons.validate(dto.couponCode, {
          subtotalCents: view.subtotalCents,
          userId: user?.id ?? null,
          email,
        })
      : null;

    const quote = await this.pricing.quote(view.items, shippingAddress, coupon);

    const order = await this.upsertPendingOrder({
      cartId: cart.id,
      userId: user?.id ?? null,
      guestEmail: user ? null : email,
      locale,
      quote,
      couponId: coupon?.coupon.id ?? null,
      shippingAddress,
      billingAddress,
      customerNote: dto.customerNote ?? null,
      network,
    });

    if (dto.saveAddress && user) await this.saveAddressToBook(user.id, shippingAddress);

    const intent = await this.ensurePaymentIntent(order, email);

    return {
      clientSecret: this.requireClientSecret(intent),
      paymentIntentId: intent.id,
      order: this.toSummary(order, email),
    };
  }

  /* ------------------------------- Résultat ----------------------------- */

  /**
   * État d'un paiement au retour du client (page de succès). Le
   * `clientSecret` sert de preuve de possession : sans lui, impossible de
   * lire la commande d'autrui. Si Stripe dit « payé » et que la commande
   * est encore PENDING (webhook pas encore passé), la finalisation
   * idempotente est exécutée ICI — la page de succès n'attend jamais.
   */
  async result(paymentIntentId: string, clientSecret: string): Promise<CheckoutResultDto> {
    let intent: Stripe.PaymentIntent;
    try {
      intent = await this.stripe.retrievePaymentIntent(paymentIntentId);
    } catch {
      throw new NotFoundException('Paiement introuvable.');
    }
    if (!intent.client_secret || intent.client_secret !== clientSecret) {
      throw new ForbiddenException('Preuve de paiement invalide.');
    }

    const include = {
      items: true,
      coupon: { select: { code: true } },
      user: { select: { email: true } },
    } as const;
    const orderId = intent.metadata?.orderId;
    const order = orderId
      ? await this.prisma.order.findUnique({ where: { id: orderId }, include })
      : null;
    if (!order) throw new NotFoundException('Commande introuvable.');

    if (intent.status === 'succeeded' && order.status === 'PENDING') {
      await this.finalizer.finalizePaidOrder(order.id, intent);
      const refreshed = await this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include,
      });
      return this.resultFor(intent, refreshed);
    }

    return this.resultFor(intent, order);
  }

  private resultFor(intent: Stripe.PaymentIntent, order: OrderWithItems): CheckoutResultDto {
    const email = order.guestEmail ?? order.user?.email ?? '';
    const summary = this.toSummary(order, email);

    if (intent.status === 'succeeded') {
      if (order.status === 'CANCELLED') {
        return { status: 'cancelled_insufficient_stock', order: summary };
      }
      return { status: 'paid', order: summary };
    }
    if (intent.status === 'processing') return { status: 'processing', order: summary };
    if (intent.status === 'requires_action' || intent.status === 'requires_confirmation') {
      return { status: 'requires_action', order: summary };
    }
    if (intent.status === 'canceled') return { status: 'cancelled', order: summary };
    return {
      status: 'payment_failed',
      order: summary,
      failureMessage: intent.last_payment_error?.message ?? null,
    };
  }

  /* ------------------------- Commande PENDING ---------------------------- */

  private async upsertPendingOrder(params: {
    cartId: string;
    userId: string | null;
    guestEmail: string | null;
    locale: Locale;
    quote: CheckoutQuote;
    couponId: string | null;
    shippingAddress: CheckoutAddress;
    billingAddress: CheckoutAddress;
    customerNote: string | null;
    network: { ip: string | null; userAgent: string | null };
  }): Promise<OrderWithItems> {
    const { quote } = params;

    const orderScalarData = {
      userId: params.userId,
      guestEmail: params.guestEmail,
      locale: params.locale,
      currency: 'CAD' as const,
      subtotalCents: quote.subtotalCents,
      discountCents: quote.discountCents,
      shippingCents: quote.shippingCents,
      taxGstCents: quote.taxes.gstCents,
      taxQstCents: quote.taxes.qstCents,
      taxHstCents: quote.taxes.hstCents,
      taxPstCents: quote.taxes.pstCents,
      totalCents: quote.totalCents,
      couponId: params.couponId,
      shippingAddress: params.shippingAddress as unknown as Prisma.InputJsonValue,
      billingAddress: params.billingAddress as unknown as Prisma.InputJsonValue,
      shippingProvince: params.shippingAddress.province,
      customerNote: params.customerNote,
      ipAddress: params.network.ip,
      userAgent: params.network.userAgent,
    };

    const itemsData = quote.lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      sku: line.sku,
      nameFr: line.nameFr,
      nameEn: line.nameEn,
      nominalLabel: line.nominalLabel,
      merv: line.merv,
      packSize: line.packSize,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      subtotalCents: line.subtotalCents,
      taxCents: line.taxCents,
      totalCents: line.totalCents,
    }));

    const upsert = async (): Promise<OrderWithItems> =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.order.findUnique({ where: { cartId: params.cartId } });

        if (existing && existing.status !== 'PENDING') {
          throw new ConflictException({
            code: 'ORDER_ALREADY_FINALIZED',
            message: 'Cette commande est déjà réglée.',
          });
        }

        if (existing) {
          // Recotation : les instantanés order_items sont immuables (trigger
          // SQL) — on remplace les lignes, on ne les modifie jamais.
          await tx.orderItem.deleteMany({ where: { orderId: existing.id } });
          return tx.order.update({
            where: { id: existing.id },
            data: { ...orderScalarData, placedAt: new Date(), items: { create: itemsData } },
            include: { items: true, coupon: { select: { code: true } } },
          });
        }

        const number = await allocateOrderNumber(tx);
        return tx.order.create({
          data: {
            number,
            cartId: params.cartId,
            channel: 'WEB',
            status: 'PENDING',
            ...orderScalarData,
            items: { create: itemsData },
            statusHistory: { create: { toStatus: 'PENDING', note: 'Commande créée au checkout' } },
          },
          include: { items: true, coupon: { select: { code: true } } },
        });
      });

    try {
      return await upsert();
    } catch (error) {
      // Deux sessions simultanées sur le même panier : la seconde perd la
      // course à l'unicité de cart_id et repasse en mode mise à jour.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return upsert();
      }
      throw error;
    }
  }

  /* --------------------------- PaymentIntent ----------------------------- */

  /**
   * Réutilise le PaymentIntent de la commande tant qu'il est payable (le
   * montant est mis à jour), sinon en crée un neuf. Un intent déjà réglé
   * fait échouer la session : la finalisation suit son cours.
   */
  private async ensurePaymentIntent(
    order: OrderWithItems,
    email: string,
  ): Promise<Stripe.PaymentIntent> {
    const metadata = { orderId: order.id, orderNumber: order.number, cartId: order.cartId ?? '' };
    const existing = await this.prisma.payment.findFirst({
      // Un paiement CANCELLED désigne un intent définitivement abandonné
      // (remplacé) : on ne le réutilise jamais.
      where: {
        orderId: order.id,
        provider: 'STRIPE',
        externalId: { not: null },
        status: { not: 'CANCELLED' },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing?.externalId) {
      try {
        const intent = await this.stripe.updatePaymentIntent(existing.externalId, {
          amountCents: order.totalCents,
          metadata,
          receiptEmail: email,
        });
        await this.prisma.payment.update({
          where: { id: existing.id },
          data: { amountCents: order.totalCents, status: 'PENDING' },
        });
        return intent;
      } catch (error) {
        const intent = await this.stripe
          .retrievePaymentIntent(existing.externalId)
          .catch(() => null);
        if (intent && (intent.status === 'succeeded' || intent.status === 'processing')) {
          throw new ConflictException({
            code: 'ORDER_ALREADY_FINALIZED',
            message: 'Un paiement est déjà en cours ou complété pour cette commande.',
          });
        }
        this.logger.warn(
          `PaymentIntent ${existing.externalId} non réutilisable — création d'un nouveau. Cause : ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.prisma.payment.update({
          where: { id: existing.id },
          data: { status: 'CANCELLED' },
        });
      }
    }

    const intent = await this.stripe.createPaymentIntent({
      amountCents: order.totalCents,
      currency: 'cad',
      metadata,
      receiptEmail: email,
    });
    await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'STRIPE',
        status: 'PENDING',
        amountCents: order.totalCents,
        currency: 'CAD',
        externalId: intent.id,
      },
    });
    return intent;
  }

  private requireClientSecret(intent: Stripe.PaymentIntent): string {
    if (!intent.client_secret) {
      throw new ConflictException({
        code: 'PAYMENT_NOT_PAYABLE',
        message: 'Ce paiement ne peut plus être complété.',
      });
    }
    return intent.client_secret;
  }

  /* ------------------------------ Validation ----------------------------- */

  private assertCartClean(view: CartDto): void {
    const { removed, adjusted, priceChanged } = view.changes;
    if (removed.length > 0 || adjusted.length > 0 || priceChanged.length > 0) {
      throw new ConflictException({
        code: 'CART_CHANGED',
        message:
          'Le panier a changé depuis son affichage (produit retiré, stock ou prix modifié). Vérifiez-le puis réessayez.',
        changes: view.changes,
      });
    }
    if (view.items.length === 0) {
      throw new BadRequestException({ code: 'CART_EMPTY', message: 'Le panier est vide.' });
    }
  }

  private resolveEmail(user: User | null, dtoEmail: string | undefined): string {
    if (user) return user.email;
    const parsed = emailSchema.safeParse(dtoEmail);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'EMAIL_REQUIRED',
        message: 'Un courriel valide est requis pour commander en invité.',
      });
    }
    return parsed.data.toLowerCase();
  }

  private async resolveShippingAddress(
    user: User | null,
    dto: CreateCheckoutSessionDto,
  ): Promise<CheckoutAddress> {
    if (dto.shippingAddressId) {
      if (!user) {
        throw new BadRequestException({
          code: 'ADDRESS_BOOK_REQUIRES_ACCOUNT',
          message: 'Le carnet d’adresses exige un compte connecté.',
        });
      }
      const saved = await this.prisma.address.findFirst({
        where: { id: dto.shippingAddressId, userId: user.id },
      });
      if (!saved) throw new NotFoundException('Adresse introuvable dans le carnet.');
      return this.parseAddress(
        {
          firstName: saved.firstName ?? user.firstName ?? '',
          lastName: saved.lastName ?? user.lastName ?? '',
          company: saved.company ?? undefined,
          line1: saved.line1,
          line2: saved.line2 ?? undefined,
          city: saved.city,
          province: saved.province,
          postalCode: saved.postalCode,
          country: saved.country === 'US' ? 'US' : 'CA',
          phone: saved.phone ?? undefined,
        },
        'shippingAddressId',
      );
    }
    if (!dto.shippingAddress) {
      throw new BadRequestException({
        code: 'SHIPPING_ADDRESS_REQUIRED',
        message: 'Adresse de livraison requise.',
      });
    }
    return this.parseAddress(dto.shippingAddress, 'shippingAddress');
  }

  /** Validation fine CA/US (@ffc/core) → 400 détaillé champ par champ. */
  private parseAddress(raw: CheckoutAddressDto, field: string): CheckoutAddress {
    const parsed = checkoutAddressSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_ADDRESS',
        field,
        message: 'Adresse invalide.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  private async saveAddressToBook(userId: string, address: CheckoutAddress): Promise<void> {
    const duplicate = await this.prisma.address.findFirst({
      where: {
        userId,
        line1: address.line1,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        country: address.country,
      },
    });
    if (duplicate) return;
    const hasDefault = await this.prisma.address.count({
      where: { userId, isDefaultShipping: true },
    });
    await this.prisma.address.create({
      data: {
        userId,
        firstName: address.firstName,
        lastName: address.lastName,
        company: address.company ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        country: address.country,
        phone: address.phone ?? null,
        isDefaultShipping: hasDefault === 0,
      },
    });
  }

  /* -------------------------------- Vues --------------------------------- */

  private toSummary(order: OrderWithItems, email: string): OrderSummaryDto {
    const address = order.shippingAddress as unknown as CheckoutAddress;
    return {
      id: order.id,
      number: order.number,
      currency: order.currency,
      email: order.guestEmail ?? email,
      lines: order.items.map((item) => ({
        sku: item.sku,
        nameFr: item.nameFr,
        nameEn: item.nameEn,
        nominalLabel: item.nominalLabel,
        packSize: item.packSize,
        merv: item.merv,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountCents: item.discountCents,
        subtotalCents: item.subtotalCents,
        taxCents: item.taxCents,
        totalCents: item.totalCents,
      })),
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      shippingCents: order.shippingCents,
      taxGstCents: order.taxGstCents,
      taxQstCents: order.taxQstCents,
      taxHstCents: order.taxHstCents,
      taxPstCents: order.taxPstCents,
      totalTaxCents: order.taxGstCents + order.taxQstCents + order.taxHstCents + order.taxPstCents,
      totalCents: order.totalCents,
      couponCode: order.coupon?.code ?? null,
      shippingAddress: {
        firstName: address.firstName,
        lastName: address.lastName,
        company: address.company ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city,
        province: address.province,
        postalCode: address.postalCode,
        country: address.country,
        phone: address.phone ?? null,
      },
    };
  }
}
