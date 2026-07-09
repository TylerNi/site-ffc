import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { type Env } from '../../../config/env';
import { PrismaService } from '../../../database';
import { Public } from '../../auth/decorators';
import { ShipstationQueueService } from './shipstation-queue.service';
import { type ShipstationWebhookBody } from './shipstation.types';

/** En-tête accepté en plus du paramètre `?token=` (au choix de la config ShipStation). */
export const SHIPSTATION_TOKEN_HEADER = 'x-shipstation-token';

/**
 * Endpoint des webhooks ShipStation (tâche 13).
 *
 * ShipStation NE SIGNE PAS ses appels : l'authentification repose sur un
 * SECRET PARTAGÉ, placé dans l'URL enregistrée côté ShipStation
 * (`…/v1/webhooks/shipstation?token=…`, en HTTPS) ou dans un en-tête. La
 * comparaison est à temps constant.
 *
 * Le corps ne porte qu'une `resource_url` : elle est enregistrée dans
 * `webhook_events` (unicité source+external_id ⇒ une relivraison ne
 * retraite rien), puis suivie de façon asynchrone. La réponse 200 part tout
 * de suite. Si un appel se perd malgré tout, le polling de repli rattrape.
 */
@Controller('webhooks')
export class ShipstationWebhookController {
  private readonly logger = new Logger(ShipstationWebhookController.name);
  private readonly secret: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ShipstationQueueService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('SHIPSTATION_WEBHOOK_SECRET', { infer: true });
  }

  @Public()
  @SkipThrottle()
  @Post('shipstation')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint() // appelé par ShipStation, pas par nos clients
  async handle(
    @Body() body: ShipstationWebhookBody,
    @Query('token') queryToken?: string,
    @Headers(SHIPSTATION_TOKEN_HEADER) headerToken?: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    this.authenticate(queryToken ?? headerToken);

    if (!body?.resource_url || typeof body.resource_url !== 'string') {
      throw new BadRequestException('resource_url manquante.');
    }

    let row;
    try {
      row = await this.prisma.webhookEvent.create({
        data: {
          source: 'shipstation',
          // ShipStation ne fournit pas d'identifiant d'événement : la
          // resource_url identifie le lot et sert de clé d'idempotence.
          externalId: body.resource_url,
          type: body.resource_type ?? null,
          payload: body as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { received: true, duplicate: true };
      }
      throw error;
    }

    await this.queue.enqueueWebhook(row.id);
    return { received: true };
  }

  private authenticate(provided: string | undefined): void {
    if (!this.secret) {
      // Refuser plutôt que d'ingérer des données non authentifiées.
      throw new ServiceUnavailableException(
        'Webhook ShipStation indisponible : SHIPSTATION_WEBHOOK_SECRET n’est pas configuré.',
      );
    }
    if (!provided || !constantTimeEquals(provided, this.secret)) {
      this.logger.warn('Webhook ShipStation rejeté : jeton absent ou invalide.');
      throw new UnauthorizedException('Jeton de webhook invalide.');
    }
  }
}

/** Comparaison à temps constant, insensible à la différence de longueur. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Compare quand même pour ne pas révéler la longueur par le temps de réponse.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
