import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { type Request } from 'express';
import { PrismaService } from '../../../database';
import { Public } from '../../auth/decorators';
import { StripeService } from '../stripe/stripe.service';
import { WebhookQueueService } from './webhook-queue.service';

/**
 * Endpoint dédié aux webhooks Stripe (tâche 11).
 *
 *   1. SIGNATURE vérifiée sur le corps BRUT (rawBody) — tout corps altéré
 *      ou non signé par notre secret est rejeté en 400 ;
 *   2. idempotence : l'événement est enregistré dans webhook_events sous
 *      l'unicité (source, external_id) — un rejeu répond 200 sans créer de
 *      second enregistrement ni de second traitement ;
 *   3. traitement ASYNCHRONE en file BullMQ — la réponse 200 part tout de
 *      suite, Stripe ne retente que les vrais échecs de réception.
 */
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly queue: WebhookQueueService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint() // appelé par Stripe, pas par nos clients
  async handleStripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    if (!signature || !req.rawBody) {
      throw new BadRequestException('Signature Stripe manquante.');
    }

    let event;
    try {
      event = this.stripe.constructWebhookEvent(req.rawBody, signature);
    } catch (error) {
      this.logger.warn(
        `Webhook Stripe rejeté : signature invalide (${error instanceof Error ? error.message : error})`,
      );
      throw new BadRequestException('Signature Stripe invalide.');
    }

    let row;
    try {
      row = await this.prisma.webhookEvent.create({
        data: {
          source: 'stripe',
          externalId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Rejeu du même événement : accusé de réception, zéro double effet.
        return { received: true, duplicate: true };
      }
      throw error;
    }

    await this.queue.enqueue(row.id);
    return { received: true };
  }
}
