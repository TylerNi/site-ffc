import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database';
import { ShipstationShipmentsService } from './shipstation-shipments.service';
import { SHIP_NOTIFY, type ShipstationWebhookBody } from './shipstation.types';

/**
 * Consommateur des webhooks ShipStation (tâche 13) — appelé par la file
 * BullMQ (worker.ts) ou inline sans Redis.
 *
 * Le corps du webhook ne contient AUCUNE donnée d'expédition : seulement une
 * `resource_url` à suivre. L'idempotence tient donc à trois niveaux, comme
 * pour Stripe :
 *   1. unicité (source, external_id) de `webhook_events` — `resource_url`
 *      identifie le lot ; une relivraison ne crée pas de second traitement ;
 *   2. statut de la ligne : PROCESSED/IGNORED ⇒ retraitement refusé ;
 *   3. l'ingestion elle-même est idempotente (unicité de
 *      `shipments.shipstation_shipment_id`, transitions conditionnelles).
 */
@Injectable()
export class ShipstationWebhookProcessorService {
  private readonly logger = new Logger(ShipstationWebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipstationShipmentsService,
  ) {}

  async process(webhookEventId: string): Promise<void> {
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!row) return;
    if (row.status === 'PROCESSED' || row.status === 'IGNORED') return;

    await this.prisma.webhookEvent.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });

    const body = row.payload as unknown as ShipstationWebhookBody;

    // ShipStation émet d'autres types (ORDER_NOTIFY, ITEM_ORDER_NOTIFY…) :
    // seule la création d'étiquette nous concerne.
    if (row.type !== SHIP_NOTIFY) {
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return;
    }

    try {
      const report = await this.shipments.ingestFromResourceUrl(body.resource_url);
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: 'PROCESSED', processedAt: new Date(), failureReason: null },
      });
      this.logger.log(
        `Webhook ShipStation : ${report.created} expédition(s) créée(s), ${report.ordersShipped} commande(s) expédiée(s).`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: 'FAILED', failureReason: reason.slice(0, 1000) },
      });
      this.logger.error(`Webhook ShipStation (${row.externalId}) en échec : ${reason}`);
      // BullMQ retente avec recul exponentiel ; à défaut, le polling rattrape.
      throw error;
    }
  }
}
