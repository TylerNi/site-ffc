import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database';
import { AuditService } from '../audit/audit.service';
import { generateOpaqueToken, sha256Hex } from './crypto.util';
import { type RequestContext } from './token.service';

/** Durée de vie d'un panier invité inactif. */
export const GUEST_CART_TTL_DAYS = 30;

export interface GuestCartCreated {
  guestCartToken: string;
  expiresAt: Date;
}

/**
 * Mode invité (tâche 05) : un panier anonyme est identifié par un jeton
 * opaque de 256 bits remis au client — stocké HACHÉ (SHA-256) dans
 * `carts.guest_token`, comme tout jeton porteur du projet.
 *
 * Règles de fusion à la connexion/inscription (docs/auth.md) :
 *   1. Compte sans panier actif → le panier invité est simplement rattaché
 *      au compte (les lignes et prix consignés sont conservés).
 *   2. Compte avec panier actif → les lignes de l'invité s'y versent :
 *      même variante → les quantités s'ADDITIONNENT et le prix consigné à
 *      l'ajout (`added_at_price_cents`) prend la valeur du panier invité
 *      (l'intention la plus récente) ; nouvelle variante → ligne copiée.
 *      Le panier invité est ensuite marqué ABANDONED.
 *   3. Dans tous les cas le jeton invité est invalidé (usage unique).
 *   4. Jeton inconnu, expiré ou déjà consommé → la fusion est IGNORÉE en
 *      silence : un panier périmé ne doit jamais bloquer une connexion.
 */
@Injectable()
export class GuestCartService {
  private readonly logger = new Logger(GuestCartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(): Promise<GuestCartCreated> {
    const raw = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + GUEST_CART_TTL_DAYS * 86_400_000);
    await this.prisma.cart.create({
      data: { guestToken: sha256Hex(raw), status: 'ACTIVE', expiresAt },
    });
    return { guestCartToken: raw, expiresAt };
  }

  /**
   * Fusionne le panier invité `rawToken` dans le compte `userId`.
   * Ne lance jamais : les erreurs sont journalisées et la connexion continue.
   */
  async mergeIntoAccount(
    userId: string,
    rawToken: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    if (!rawToken) return;
    try {
      const merged = await this.prisma.$transaction(async (tx) => {
        const guestCart = await tx.cart.findFirst({
          where: {
            guestToken: sha256Hex(rawToken),
            status: 'ACTIVE',
            userId: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          include: { items: true },
        });
        if (!guestCart) return null;

        const accountCart = await tx.cart.findFirst({
          where: { userId, status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' },
        });

        if (!accountCart) {
          // Cas 1 : rattachement direct — le panier devient celui du compte.
          await tx.cart.update({
            where: { id: guestCart.id },
            data: { userId, guestToken: null, expiresAt: null },
          });
          return { cartId: guestCart.id, itemsMoved: guestCart.items.length, attached: true };
        }

        // Cas 2 : versement ligne à ligne dans le panier du compte.
        for (const item of guestCart.items) {
          const existing = await tx.cartItem.findUnique({
            where: { cartId_variantId: { cartId: accountCart.id, variantId: item.variantId } },
          });
          if (existing) {
            await tx.cartItem.update({
              where: { id: existing.id },
              data: {
                quantity: existing.quantity + item.quantity,
                addedAtPriceCents: item.addedAtPriceCents ?? existing.addedAtPriceCents,
              },
            });
          } else {
            await tx.cartItem.create({
              data: {
                cartId: accountCart.id,
                variantId: item.variantId,
                quantity: item.quantity,
                addedAtPriceCents: item.addedAtPriceCents,
              },
            });
          }
        }
        await tx.cartItem.deleteMany({ where: { cartId: guestCart.id } });
        // Le panier vidé est rattaché au compte (la contrainte carts_owner_check
        // exige un propriétaire : user_id OU guest_token) puis clos.
        await tx.cart.update({
          where: { id: guestCart.id },
          data: { userId, status: 'ABANDONED', guestToken: null, expiresAt: new Date() },
        });
        return { cartId: accountCart.id, itemsMoved: guestCart.items.length, attached: false };
      });

      if (merged) {
        await this.audit.log({
          action: 'cart.merge_guest',
          actorId: userId,
          entityType: 'cart',
          entityId: merged.cartId,
          metadata: { itemsMoved: merged.itemsMoved, attached: merged.attached },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    } catch (error) {
      this.logger.error(`Fusion du panier invité impossible (user=${userId})`, error);
    }
  }
}
