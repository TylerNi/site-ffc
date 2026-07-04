import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from './decorators';
import { GuestCartResponseDto } from './dto/auth.dto';
import { GuestCartService } from './guest-cart.service';

/**
 * Mode invité : émission du jeton de panier anonyme. Les opérations sur le
 * contenu du panier (lignes, quantités) arrivent avec la tâche 11 ; la
 * fusion vers un compte se fait via `guestCartToken` au login/register.
 */
@ApiTags('auth')
@Controller('auth/guest-cart')
export class GuestCartController {
  constructor(private readonly guestCarts: GuestCartService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 15 * 60_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crée un panier invité et retourne son jeton opaque',
    description:
      'Le jeton (256 bits, haché en base) identifie le panier anonyme pendant 30 jours. À présenter au login/register pour fusionner le panier dans le compte.',
    operationId: 'createGuestCart',
  })
  @ApiOkResponse({ type: GuestCartResponseDto })
  async create(): Promise<GuestCartResponseDto> {
    const created = await this.guestCarts.create();
    return {
      guestCartToken: created.guestCartToken,
      expiresAt: created.expiresAt.toISOString(),
    };
  }
}
