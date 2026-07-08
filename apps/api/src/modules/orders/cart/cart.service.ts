import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { type Cart, type Prisma } from '@prisma/client';
import { PrismaService } from '../../../database';
import { generateOpaqueToken, sha256Hex } from '../../auth/crypto.util';
import { GUEST_CART_TTL_DAYS } from '../../auth/guest-cart.service';
import {
  type AdjustedCartLineDto,
  type CartDto,
  type CartLineDto,
  type PriceChangedCartLineDto,
  type RemovedCartLineDto,
} from './dto/cart.dto';

/**
 * Identité du porteur de panier : compte connecté OU jeton invité
 * (en-tête X-Cart-Token, jeton opaque de la tâche 05, haché en base).
 * Quand les deux sont présents, le compte gagne — la fusion invité→compte
 * ne se fait qu'au login (règles de docs/auth.md), jamais implicitement.
 */
export interface CartOwner {
  userId: string | null;
  rawGuestToken: string | null;
}

/** Ligne de panier avec tout le contexte produit nécessaire à la validation. */
const cartItemInclude = {
  variant: {
    include: {
      product: {
        include: { translations: true, images: { orderBy: { position: 'asc' as const }, take: 1 } },
      },
      inventoryLevel: true,
    },
  },
} satisfies Prisma.CartItemInclude;

type LoadedCartItem = Prisma.CartItemGetPayload<{ include: typeof cartItemInclude }>;

export interface ValidatedCart {
  cart: Cart | null;
  view: CartDto;
}

function availableQuantity(item: LoadedCartItem): number {
  const level = item.variant.inventoryLevel;
  if (!level) return 0;
  return level.quantityOnHand - level.quantityReserved;
}

function isSellable(item: LoadedCartItem): boolean {
  return item.variant.isActive && item.variant.product.status === 'ACTIVE';
}

function translation(item: LoadedCartItem, locale: 'fr' | 'en') {
  return item.variant.product.translations.find((entry) => entry.locale === locale);
}

function toLine(item: LoadedCartItem): CartLineDto {
  return {
    variantId: item.variantId,
    productId: item.variant.productId,
    sku: item.variant.sku,
    quantity: item.quantity,
    unitPriceCents: item.variant.priceCents,
    currency: item.variant.currency,
    lineSubtotalCents: item.variant.priceCents * item.quantity,
    nameFr: translation(item, 'fr')?.name ?? item.variant.sku,
    nameEn: translation(item, 'en')?.name ?? item.variant.sku,
    slugFr: translation(item, 'fr')?.slug ?? null,
    slugEn: translation(item, 'en')?.slug ?? null,
    nominalLabel: item.variant.nominalLabel,
    packSize: item.variant.packSize,
    merv: item.variant.merv,
    imageUrl: item.variant.product.images[0]?.url ?? null,
    availableQuantity: availableQuantity(item),
  };
}

function names(item: LoadedCartItem): { sku: string; nameFr: string; nameEn: string } {
  return {
    sku: item.variant.sku,
    nameFr: translation(item, 'fr')?.name ?? item.variant.sku,
    nameEn: translation(item, 'en')?.name ?? item.variant.sku,
  };
}

const EMPTY_CART: CartDto = {
  id: null,
  currency: 'CAD',
  items: [],
  subtotalCents: 0,
  itemCount: 0,
  changes: { removed: [], adjusted: [], priceChanged: [] },
};

/**
 * Panier (tâche 11) : compte + invité, avec REVALIDATION SERVEUR à chaque
 * opération — prix, stock et statut de publication sont relus de la base,
 * jamais crus du client. Les écarts apparus entre l'ajout et la lecture
 * (produit dépublié, épuisé, prix modifié) sont corrigés en base (« retrait
 * propre ») et signalés une fois dans `changes`.
 */
@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /* ----------------------------- Résolution ---------------------------- */

  /** Panier ACTIF du porteur, ou null. Jeton inconnu/expiré ⇒ null (auto-guérison). */
  async findActiveCart(owner: CartOwner): Promise<Cart | null> {
    if (owner.userId) {
      return this.prisma.cart.findFirst({
        where: { userId: owner.userId, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
      });
    }
    if (owner.rawGuestToken) {
      return this.prisma.cart.findFirst({
        where: {
          guestToken: sha256Hex(owner.rawGuestToken),
          status: 'ACTIVE',
          userId: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
    }
    return null;
  }

  /* ------------------------------- Lecture ------------------------------ */

  async getCart(owner: CartOwner): Promise<CartDto> {
    const cart = await this.findActiveCart(owner);
    if (!cart) return { ...EMPTY_CART, changes: { removed: [], adjusted: [], priceChanged: [] } };
    return this.reconcile(cart.id);
  }

  /**
   * Relit toutes les lignes, corrige les écarts en base et retourne la vue.
   * C'est LE point de vérité utilisé par le GET panier et par le checkout.
   */
  async reconcile(cartId: string): Promise<CartDto> {
    const removed: RemovedCartLineDto[] = [];
    const adjusted: AdjustedCartLineDto[] = [];
    const priceChanged: PriceChangedCartLineDto[] = [];

    const lines = await this.prisma.$transaction(async (tx) => {
      const items = await tx.cartItem.findMany({
        where: { cartId },
        include: cartItemInclude,
        orderBy: { createdAt: 'asc' },
      });

      const kept: CartLineDto[] = [];
      for (const item of items) {
        if (!isSellable(item)) {
          await tx.cartItem.delete({ where: { id: item.id } });
          removed.push({ ...names(item), reason: 'UNAVAILABLE' });
          continue;
        }
        const available = availableQuantity(item);
        if (available <= 0) {
          await tx.cartItem.delete({ where: { id: item.id } });
          removed.push({ ...names(item), reason: 'OUT_OF_STOCK' });
          continue;
        }

        let quantity = item.quantity;
        if (quantity > available) {
          quantity = available;
          await tx.cartItem.update({ where: { id: item.id }, data: { quantity } });
          adjusted.push({ ...names(item), fromQuantity: item.quantity, toQuantity: quantity });
        }

        if (item.addedAtPriceCents !== null && item.addedAtPriceCents !== item.variant.priceCents) {
          priceChanged.push({
            ...names(item),
            fromCents: item.addedAtPriceCents,
            toCents: item.variant.priceCents,
          });
          // Consigne le prix courant : l'écart n'est signalé qu'une fois.
          await tx.cartItem.update({
            where: { id: item.id },
            data: { addedAtPriceCents: item.variant.priceCents },
          });
        }

        kept.push({
          ...toLine(item),
          quantity,
          lineSubtotalCents: item.variant.priceCents * quantity,
        });
      }
      return kept;
    });

    return {
      id: cartId,
      currency: 'CAD',
      items: lines,
      subtotalCents: lines.reduce((sum, line) => sum + line.lineSubtotalCents, 0),
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      changes: { removed, adjusted, priceChanged },
    };
  }

  /* ------------------------------ Mutations ----------------------------- */

  /**
   * Ajoute (ou additionne) une ligne. Sans panier existant : un panier est
   * créé — invité, le jeton opaque est retourné une seule fois dans la vue.
   */
  async addItem(owner: CartOwner, variantId: string, quantity: number): Promise<CartDto> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { select: { status: true } }, inventoryLevel: true },
    });
    if (!variant) throw new NotFoundException('Produit introuvable.');
    if (!variant.isActive || variant.product.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'UNAVAILABLE',
        message: 'Ce produit n’est plus offert.',
      });
    }

    let cart = await this.findActiveCart(owner);
    let issuedGuestToken: string | null = null;

    if (!cart) {
      if (owner.userId) {
        cart = await this.prisma.cart.create({ data: { userId: owner.userId, status: 'ACTIVE' } });
      } else {
        // Nouveau panier invité : jeton opaque remis UNE fois, haché en base
        // (mêmes règles que GuestCartService, tâche 05).
        issuedGuestToken = generateOpaqueToken();
        cart = await this.prisma.cart.create({
          data: {
            guestToken: sha256Hex(issuedGuestToken),
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + GUEST_CART_TTL_DAYS * 86_400_000),
          },
        });
      }
    }

    const existing = await this.prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
    });
    const requested = (existing?.quantity ?? 0) + quantity;
    this.assertStock(variant, requested);

    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: {
        cartId: cart.id,
        variantId,
        quantity,
        addedAtPriceCents: variant.priceCents,
      },
      update: { quantity: requested, addedAtPriceCents: variant.priceCents },
    });
    await this.touch(cart);

    const view = await this.reconcile(cart.id);
    return issuedGuestToken ? { ...view, guestCartToken: issuedGuestToken } : view;
  }

  async updateItem(owner: CartOwner, variantId: string, quantity: number): Promise<CartDto> {
    const { cart, item } = await this.requireItem(owner, variantId);
    this.assertStock(item.variant, quantity);
    await this.prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    await this.touch(cart);
    return this.reconcile(cart.id);
  }

  async removeItem(owner: CartOwner, variantId: string): Promise<CartDto> {
    const { cart, item } = await this.requireItem(owner, variantId);
    await this.prisma.cartItem.delete({ where: { id: item.id } });
    await this.touch(cart);
    return this.reconcile(cart.id);
  }

  /* ------------------------------- Détails ------------------------------ */

  private async requireItem(owner: CartOwner, variantId: string) {
    const cart = await this.findActiveCart(owner);
    if (!cart) throw new NotFoundException('Panier introuvable.');
    const item = await this.prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      include: cartItemInclude,
    });
    if (!item) throw new NotFoundException('Cette ligne n’est pas dans le panier.');
    return { cart, item };
  }

  private assertStock(
    variant: { inventoryLevel: { quantityOnHand: number; quantityReserved: number } | null },
    requested: number,
  ): void {
    const available = variant.inventoryLevel
      ? variant.inventoryLevel.quantityOnHand - variant.inventoryLevel.quantityReserved
      : 0;
    if (requested > available) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        availableQuantity: Math.max(available, 0),
        message:
          available > 0
            ? `Stock insuffisant : ${available} exemplaire(s) disponible(s).`
            : 'Ce produit est épuisé.',
      });
    }
  }

  /** Rafraîchit updated_at et fait GLISSER l'expiration des paniers invités. */
  private async touch(cart: Cart): Promise<void> {
    await this.prisma.cart.update({
      where: { id: cart.id },
      data: cart.guestToken
        ? { expiresAt: new Date(Date.now() + GUEST_CART_TTL_DAYS * 86_400_000) }
        : { updatedAt: new Date() },
    });
  }
}
