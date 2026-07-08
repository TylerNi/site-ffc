import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OptionalAuth } from '../../auth/decorators';
import { type AuthenticatedRequest } from '../../auth/request-context';
import { CartService, type CartOwner } from './cart.service';
import { AddCartItemDto, CartDto, UpdateCartItemDto } from './dto/cart.dto';

/** En-tête porteur du jeton de panier invité (jamais en query string). */
export const CART_TOKEN_HEADER = 'x-cart-token';

export function cartOwnerFrom(req: AuthenticatedRequest): CartOwner {
  const header = req.headers[CART_TOKEN_HEADER];
  const rawGuestToken = typeof header === 'string' && header.length > 0 ? header : null;
  return { userId: req.user?.id ?? null, rawGuestToken };
}

const GUEST_HEADER_DOC = {
  name: 'X-Cart-Token',
  required: false,
  description:
    'Jeton de panier invité (émis à la première addition ou via POST /v1/auth/guest-cart). Ignoré quand un Bearer est présent : le panier du compte prime.',
};

/**
 * Panier compte + invité (tâche 11). Toutes les réponses renvoient l'état
 * complet et RÉCONCILIÉ du panier : prix relus, lignes mortes retirées,
 * quantités rabattues au stock — avec le détail des écarts dans `changes`.
 */
@ApiTags('cart')
@OptionalAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiHeader(GUEST_HEADER_DOC)
  @ApiOperation({
    summary: 'Panier courant, revalidé côté serveur',
    description:
      'Jeton invité inconnu ou expiré ⇒ panier vide (jamais d’erreur). Les écarts corrigés (produit dépublié, épuisé, prix changé) sont signalés une seule fois dans `changes`.',
    operationId: 'getCart',
  })
  @ApiOkResponse({ type: CartDto })
  get(@Req() req: AuthenticatedRequest): Promise<CartDto> {
    return this.carts.getCart(cartOwnerFrom(req));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @ApiHeader(GUEST_HEADER_DOC)
  @ApiOperation({
    summary: 'Ajoute une variante (les quantités s’additionnent)',
    description:
      'Sans panier existant, un panier est créé ; pour un invité, `guestCartToken` est retourné UNE seule fois — à stocker et renvoyer dans X-Cart-Token.',
    operationId: 'addCartItem',
  })
  @ApiOkResponse({ type: CartDto })
  add(@Req() req: AuthenticatedRequest, @Body() dto: AddCartItemDto): Promise<CartDto> {
    return this.carts.addItem(cartOwnerFrom(req), dto.variantId, dto.quantity);
  }

  @Patch('items/:variantId')
  @Header('Cache-Control', 'private, no-store')
  @ApiHeader(GUEST_HEADER_DOC)
  @ApiOperation({ summary: 'Fixe la quantité d’une ligne', operationId: 'updateCartItem' })
  @ApiOkResponse({ type: CartDto })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartDto> {
    return this.carts.updateItem(cartOwnerFrom(req), variantId, dto.quantity);
  }

  @Delete('items/:variantId')
  @Header('Cache-Control', 'private, no-store')
  @ApiHeader(GUEST_HEADER_DOC)
  @ApiOperation({ summary: 'Retire une ligne', operationId: 'removeCartItem' })
  @ApiOkResponse({ type: CartDto })
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<CartDto> {
    return this.carts.removeItem(cartOwnerFrom(req), variantId);
  }
}
