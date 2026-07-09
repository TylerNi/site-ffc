import { type ShipstationSync } from '@prisma/client';
import { ShipstationShipmentsService } from '../src/modules/shipping/shipstation/shipstation-shipments.service';
import {
  type DrainReport,
  ShipstationSyncService,
} from '../src/modules/shipping/shipstation/shipstation-sync.service';
import { TEST_SHIPSTATION_WEBHOOK_SECRET } from './auth-helpers';
import { type CheckoutTestContext, createCheckoutTestApp } from './checkout-helpers';
import { FakeShipstationClient } from './fakes/fake-shipstation';

/**
 * Contexte des e2e ShipStation (tâche 13) : application complète, faux
 * Stripe ET faux ShipStation. Le drain et le polling sont appelés
 * EXPLICITEMENT par les tests (aucune minuterie en NODE_ENV=test) — les
 * assertions portent donc sur le vrai chemin de production, sans attente.
 */
export interface ShipstationTestContext extends CheckoutTestContext {
  shipstation: FakeShipstationClient;
  sync: ShipstationSyncService;
  shipments: ShipstationShipmentsService;
  drain: () => Promise<DrainReport>;
  syncRow: (orderId: string) => Promise<ShipstationSync>;
  /** Rend la ligne immédiatement due (le recul exponentiel est testé à part). */
  makeDue: (orderId: string) => Promise<void>;
}

export async function createShipstationTestApp(): Promise<ShipstationTestContext> {
  const shipstation = new FakeShipstationClient();
  const ctx = await createCheckoutTestApp({ shipstation });
  const sync = ctx.app.get(ShipstationSyncService);
  const shipments = ctx.app.get(ShipstationShipmentsService);

  // La base ffc_test est PARTAGÉE : toute commande payée par une autre suite
  // (checkout, factures, remboursements…) a laissé une ligne d'envoi PENDING
  // que `drain()` ramasserait. On repart d'une file vide pour que les
  // compteurs de drain de CE fichier ne parlent que de ses propres commandes.
  await ctx.prisma.shipstationSync.deleteMany({});

  return {
    ...ctx,
    shipstation,
    sync,
    shipments,
    drain: () => sync.drain(),
    syncRow: (orderId) => ctx.prisma.shipstationSync.findUniqueOrThrow({ where: { orderId } }),
    makeDue: async (orderId) => {
      await ctx.prisma.shipstationSync.update({
        where: { orderId },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
    },
  };
}

/** Publie un webhook ShipStation authentifié par le secret partagé. */
export function postShipstationWebhook(
  ctx: ShipstationTestContext,
  body: { resource_url: string; resource_type: string },
  token: string = TEST_SHIPSTATION_WEBHOOK_SECRET,
): ReturnType<ReturnType<CheckoutTestContext['http']>['post']> {
  return ctx
    .http()
    .post(`/v1/webhooks/shipstation?token=${encodeURIComponent(token)}`)
    .send(body);
}
