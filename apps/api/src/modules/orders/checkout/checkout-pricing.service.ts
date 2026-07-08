import { Inject, Injectable } from '@nestjs/common';
import {
  allocateProportionally,
  type CheckoutAddress,
  type TaxCalculator,
  type TaxTotals,
} from '@ffc/core';
import { type CartLineDto } from '../cart/dto/cart.dto';
import { type AppliedCoupon } from './coupon.service';
import { ShippingService } from './shipping.service';
import { TAX_CALCULATOR } from './tax.provider';

/** Ligne cotée — l'instantané exact qui sera figé dans order_items. */
export interface PricedLine {
  variantId: string;
  productId: string;
  sku: string;
  nameFr: string;
  nameEn: string;
  nominalLabel: string | null;
  packSize: number;
  merv: number | null;
  quantity: number;
  unitPriceCents: number;
  /** Part de la remise imputée à cette ligne. */
  discountCents: number;
  /** unitPrice × quantity − remise. */
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface CheckoutQuote {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxes: TaxTotals & { totalTaxCents: number };
  totalCents: number;
}

/**
 * Cotation du checkout — LE calcul d'autorité (tâche 11) : tout part des
 * lignes RÉCONCILIÉES du panier (prix relus en base), jamais d'un montant
 * fourni par le client. Ordre des opérations :
 *   1. sous-total = Σ prix courant × quantité ;
 *   2. remise du coupon, plafonnée au sous-total, RÉPARTIE au cent près
 *      sur les lignes (plus fort reste) — la taxe se calcule sur la
 *      contrepartie réellement payée ;
 *   3. livraison : Canada gratuit, É.-U. frais fixes (settings) — offerte
 *      si coupon FREE_SHIPPING ;
 *   4. taxes par ligne et par composante via TaxCalculator (livraison
 *      taxée comme une ligne à part au Canada ; É.-U. : zéro).
 */
@Injectable()
export class CheckoutPricingService {
  constructor(
    private readonly shipping: ShippingService,
    @Inject(TAX_CALCULATOR) private readonly taxes: TaxCalculator,
  ) {}

  async quote(
    cartLines: readonly CartLineDto[],
    destination: CheckoutAddress,
    coupon: AppliedCoupon | null,
  ): Promise<CheckoutQuote> {
    const subtotalCents = cartLines.reduce((sum, line) => sum + line.lineSubtotalCents, 0);
    const discountCents = Math.min(coupon?.discountCents ?? 0, subtotalCents);
    const lineDiscounts = allocateProportionally(
      discountCents,
      cartLines.map((line) => line.lineSubtotalCents),
    );

    const shippingCents = coupon?.freeShipping
      ? 0
      : await this.shipping.shippingCentsFor(destination.country);

    const taxResult = this.taxes.calculate({
      destination: { country: destination.country, region: destination.province },
      lines: cartLines.map((line, index) => ({
        id: line.variantId,
        amountCents: line.lineSubtotalCents - lineDiscounts[index]!,
      })),
      shippingCents,
    });

    const lines: PricedLine[] = cartLines.map((line, index) => {
      const lineSubtotal = line.lineSubtotalCents - lineDiscounts[index]!;
      const taxCents = taxResult.lines[index]!.taxCents;
      return {
        variantId: line.variantId,
        productId: line.productId,
        sku: line.sku,
        nameFr: line.nameFr,
        nameEn: line.nameEn,
        nominalLabel: line.nominalLabel ?? null,
        packSize: line.packSize,
        merv: line.merv ?? null,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        discountCents: lineDiscounts[index]!,
        subtotalCents: lineSubtotal,
        taxCents,
        totalCents: lineSubtotal + taxCents,
      };
    });

    return {
      lines,
      subtotalCents,
      discountCents,
      shippingCents,
      taxes: { ...taxResult.totals, totalTaxCents: taxResult.totalTaxCents },
      totalCents: subtotalCents - discountCents + shippingCents + taxResult.totalTaxCents,
    };
  }
}
