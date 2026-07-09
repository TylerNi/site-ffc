import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ShipstationClient } from './shipstation/shipstation.client';
import { ShipstationQueueService } from './shipstation/shipstation-queue.service';
import { ShipstationShipmentsService } from './shipstation/shipstation-shipments.service';
import { ShipstationSyncService } from './shipstation/shipstation-sync.service';
import { ShipstationWebhookController } from './shipstation/shipstation-webhook.controller';
import { ShipstationWebhookProcessorService } from './shipstation/shipstation-webhook-processor.service';

/**
 * Expédition — intégration ShipStation (tâche 13). Le suivi de colis détaillé
 * (adapters de repérage, page « Mes colis ») arrive à la tâche 14.
 *
 * Sens des dépendances : ce module IMPORTE `OrdersModule` (machine d'états,
 * courriels) et n'est jamais importé par lui. Les commandes arment la boîte
 * d'envoi par des fonctions PURES (`shipstation-outbox.ts`, sans injection) :
 * aucune dépendance circulaire, et la ligne d'envoi est écrite dans la
 * transaction même du passage à `PAID`.
 */
@Module({
  imports: [OrdersModule],
  controllers: [ShipstationWebhookController],
  providers: [
    ShipstationClient,
    ShipstationSyncService,
    ShipstationShipmentsService,
    ShipstationWebhookProcessorService,
    ShipstationQueueService,
  ],
  exports: [
    // Consommés par le contrôleur admin (tâche 13) et le worker BullMQ.
    ShipstationSyncService,
    ShipstationShipmentsService,
    ShipstationWebhookProcessorService,
  ],
})
export class ShippingModule {}
