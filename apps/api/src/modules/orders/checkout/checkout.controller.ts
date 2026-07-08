import { Body, Controller, Header, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuth } from '../../auth/decorators';
import { type AuthenticatedRequest, requestContext } from '../../auth/request-context';
import { cartOwnerFrom } from '../cart/cart.controller';
import { CheckoutService } from './checkout.service';
import {
  CartChangedErrorDto,
  CheckoutResultDto,
  CheckoutResultRequestDto,
  CheckoutSessionDto,
  CreateCheckoutSessionDto,
} from './dto/checkout.dto';

const GUEST_HEADER_DOC = {
  name: 'X-Cart-Token',
  required: false,
  description: 'Jeton de panier invité — mêmes règles que /v1/cart.',
};

/**
 * Checkout Stripe (tâche 11). Le montant payé sort TOUJOURS de la cotation
 * serveur : panier revalidé, taxes par province, livraison, coupon. Le
 * client ne fournit que l'adresse, le coupon et son courriel.
 */
@ApiTags('checkout')
@OptionalAuth()
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 15 * 60_000 } })
  @ApiHeader(GUEST_HEADER_DOC)
  @ApiOperation({
    summary: 'Cote le panier et prépare le paiement (PaymentIntent)',
    description:
      'Revalide le panier (409 CART_CHANGED si un écart vient d’être corrigé), valide adresse/coupon, fige la commande PENDING et retourne le client_secret du Payment Element. Re-soumettre avec une autre adresse ou un autre coupon RECOTE la même commande.',
    operationId: 'createCheckoutSession',
  })
  @ApiOkResponse({ type: CheckoutSessionDto })
  @ApiConflictResponse({
    type: CartChangedErrorDto,
    description: 'CART_CHANGED : le panier vient d’être réconcilié — réafficher puis réessayer',
  })
  createSession(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<CheckoutSessionDto> {
    return this.checkout.createSession(
      cartOwnerFrom(req),
      req.user ?? null,
      dto,
      requestContext(req),
    );
  }

  @Post('result')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 60, ttl: 15 * 60_000 } })
  @ApiOperation({
    summary: 'État du paiement au retour du client (page de succès)',
    description:
      'Le client_secret sert de preuve de possession. Si Stripe confirme le paiement et que le webhook n’est pas encore passé, la finalisation idempotente est faite ici — la page de succès n’attend jamais.',
    operationId: 'getCheckoutResult',
  })
  @ApiOkResponse({ type: CheckoutResultDto })
  result(@Body() dto: CheckoutResultRequestDto): Promise<CheckoutResultDto> {
    return this.checkout.result(dto.paymentIntentId, dto.clientSecret);
  }
}
