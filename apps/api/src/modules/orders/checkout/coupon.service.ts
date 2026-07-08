import { BadRequestException, Injectable } from '@nestjs/common';
import { type Coupon } from '@prisma/client';
import { PrismaService } from '../../../database';

export interface CouponContext {
  subtotalCents: number;
  userId: string | null;
  /** Courriel de commande (invité) — sert au plafond « par client ». */
  email: string;
}

export interface AppliedCoupon {
  coupon: Coupon;
  /** Remise sur la marchandise (cents), plafonnée au sous-total. */
  discountCents: number;
  /** FREE_SHIPPING : la livraison passe à 0. */
  freeShipping: boolean;
}

/** Erreur de coupon avec un code stable pour l'affichage client. */
function couponError(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new BadRequestException({ code, message, ...extra });
}

/**
 * Validation SERVEUR des coupons (tâche 11) : période, minimum d'achat,
 * plafond global, plafond par client (comptes ET invités — par courriel).
 * La consommation effective (`coupon_redemptions` + compteur) se fait dans
 * la transaction de finalisation de commande, jamais ici.
 */
@Injectable()
export class CouponService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(code: string, context: CouponContext): Promise<AppliedCoupon> {
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    if (!coupon) couponError('COUPON_NOT_FOUND', 'Code promo inconnu.');
    if (!coupon.isActive) couponError('COUPON_INACTIVE', 'Ce code promo n’est plus actif.');

    const now = new Date();
    if (coupon.startsAt && coupon.startsAt > now) {
      couponError('COUPON_NOT_STARTED', 'Ce code promo n’est pas encore en vigueur.');
    }
    if (coupon.endsAt && coupon.endsAt < now) {
      couponError('COUPON_EXPIRED', 'Ce code promo est expiré.');
    }
    if (coupon.maxRedemptions !== null && coupon.timesRedeemed >= coupon.maxRedemptions) {
      couponError('COUPON_EXHAUSTED', 'Ce code promo a atteint sa limite d’utilisation.');
    }
    if (coupon.minSubtotalCents !== null && context.subtotalCents < coupon.minSubtotalCents) {
      couponError(
        'COUPON_MIN_SUBTOTAL',
        'Le sous-total du panier n’atteint pas le minimum requis pour ce code.',
        { minSubtotalCents: coupon.minSubtotalCents },
      );
    }

    if (coupon.maxRedemptionsPerUser !== null) {
      const used = await this.redemptionsByClient(coupon.id, context);
      if (used >= coupon.maxRedemptionsPerUser) {
        couponError('COUPON_ALREADY_USED', 'Vous avez déjà utilisé ce code promo.');
      }
    }

    return {
      coupon,
      discountCents: this.discountFor(coupon, context.subtotalCents),
      freeShipping: coupon.type === 'FREE_SHIPPING',
    };
  }

  /**
   * Utilisations déjà consommées par CE client : par compte quand il y en a
   * un, sinon par courriel de commande (un invité ne contourne pas le
   * plafond en restant déconnecté). Seules les commandes finalisées comptent
   * (une redemption n'existe qu'après paiement).
   */
  private async redemptionsByClient(couponId: string, context: CouponContext): Promise<number> {
    const byUser = context.userId
      ? await this.prisma.couponRedemption.count({
          where: { couponId, userId: context.userId },
        })
      : 0;
    const byEmail = await this.prisma.couponRedemption.count({
      where: {
        couponId,
        order: {
          OR: [
            { guestEmail: context.email },
            context.userId ? { userId: context.userId } : { user: { email: context.email } },
          ],
        },
      },
    });
    return Math.max(byUser, byEmail);
  }

  private discountFor(coupon: Coupon, subtotalCents: number): number {
    switch (coupon.type) {
      case 'PERCENTAGE': {
        const percent = coupon.valuePercent ?? 0;
        return Math.min(subtotalCents, Math.round((subtotalCents * percent) / 100));
      }
      case 'FIXED_AMOUNT':
        return Math.min(subtotalCents, coupon.valueCents ?? 0);
      case 'FREE_SHIPPING':
        return 0;
    }
  }
}
