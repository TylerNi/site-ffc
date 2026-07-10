import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ShipstationClient } from './shipstation/shipstation.client';
import { ShipstationQueueService } from './shipstation/shipstation-queue.service';
import { ShipstationShipmentsService } from './shipstation/shipstation-shipments.service';
import { ShipstationSyncService } from './shipstation/shipstation-sync.service';
import { ShipstationWebhookController } from './shipstation/shipstation-webhook.controller';
import { ShipstationWebhookProcessorService } from './shipstation/shipstation-webhook-processor.service';
import { CanadaPostTracker } from './tracking/adapters/canada-post.tracker';
import { CanparTracker } from './tracking/adapters/canpar.tracker';
import { NationexTracker } from './tracking/adapters/nationex.tracker';
import { PurolatorTracker } from './tracking/adapters/purolator.tracker';
import { CARRIER_TRACKERS, type CarrierTracker } from './tracking/carrier-tracker';
import { CustomerShipmentsController } from './tracking/customer-shipments.controller';
import { CustomerShipmentsService } from './tracking/customer-shipments.service';
import { TrackingAdminService } from './tracking/tracking-admin.service';
import { TrackingHttp } from './tracking/tracking-http';
import { TrackingIngestService } from './tracking/tracking-ingest.service';
import { TrackingMetricsService } from './tracking/tracking-metrics.service';
import { TrackingMilestonesService } from './tracking/tracking-milestones.service';
import { TrackingPollerService } from './tracking/tracking-poller.service';
import { TrackingQueueService } from './tracking/tracking-queue.service';

/**
 * Expédition : intégration ShipStation (tâche 13) et suivi de colis unifié
 * (tâche 14) — quatre adapters de repérage (Postes Canada, Nationex,
 * Canpar, Purolator) derrière l'interface `CarrierTracker`, worker de
 * polling adaptatif, jalons de notification et page « Mes colis ».
 *
 * Sens des dépendances : ce module IMPORTE `OrdersModule` (machine d'états,
 * courriels) et n'est jamais importé par lui. Les commandes arment la boîte
 * d'envoi par des fonctions PURES (`shipstation-outbox.ts`, sans injection) :
 * aucune dépendance circulaire, et la ligne d'envoi est écrite dans la
 * transaction même du passage à `PAID`.
 */
@Module({
  imports: [OrdersModule],
  controllers: [ShipstationWebhookController, CustomerShipmentsController],
  providers: [
    ShipstationClient,
    ShipstationSyncService,
    ShipstationShipmentsService,
    ShipstationWebhookProcessorService,
    ShipstationQueueService,
    // Tâche 14 — suivi de colis
    TrackingHttp,
    CanadaPostTracker,
    NationexTracker,
    CanparTracker,
    PurolatorTracker,
    {
      // Registre des adapters : le poller les découvre par `carrier`.
      provide: CARRIER_TRACKERS,
      useFactory: (...trackers: CarrierTracker[]): CarrierTracker[] => trackers,
      inject: [CanadaPostTracker, NationexTracker, CanparTracker, PurolatorTracker],
    },
    TrackingMetricsService,
    TrackingMilestonesService,
    TrackingIngestService,
    TrackingPollerService,
    TrackingQueueService,
    TrackingAdminService,
    CustomerShipmentsService,
  ],
  exports: [
    // Consommés par le contrôleur admin (tâches 13-14) et le worker BullMQ.
    ShipstationSyncService,
    ShipstationShipmentsService,
    ShipstationWebhookProcessorService,
    TrackingPollerService,
    TrackingAdminService,
  ],
})
export class ShippingModule {}
