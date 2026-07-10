import { type Locale } from '@ffc/core';

/**
 * Gabarits des notifications push Expo (tâche 14) — courts, sobres, dans la
 * langue du client au moment de l'achat. Les variables sont volontairement
 * réduites : une notification push n'est pas un courriel.
 */

export type PushTemplateKey =
  'shipment_out_for_delivery' | 'shipment_exception' | 'order_delivered';

export interface RenderedPush {
  title: string;
  body: string;
}

type Vars = Record<string, string>;

const TEMPLATES: Record<PushTemplateKey, Record<Locale, (vars: Vars) => RenderedPush>> = {
  shipment_out_for_delivery: {
    fr: (v) => ({
      title: 'Colis en livraison',
      body: `Votre commande ${v.orderNumber} est en cours de livraison${v.carrier ? ` par ${v.carrier}` : ''}.`,
    }),
    en: (v) => ({
      title: 'Out for delivery',
      body: `Your order ${v.orderNumber} is out for delivery${v.carrier ? ` with ${v.carrier}` : ''}.`,
    }),
  },
  shipment_exception: {
    fr: (v) => ({
      title: 'Incident de livraison',
      body: `Un incident de livraison touche votre commande ${v.orderNumber} — consultez le suivi.`,
    }),
    en: (v) => ({
      title: 'Delivery exception',
      body: `A delivery exception affects your order ${v.orderNumber} — check the tracking.`,
    }),
  },
  order_delivered: {
    fr: (v) => ({
      title: 'Commande livrée',
      body: `Votre commande ${v.orderNumber} a été livrée.`,
    }),
    en: (v) => ({
      title: 'Order delivered',
      body: `Your order ${v.orderNumber} has been delivered.`,
    }),
  },
};

export function renderPush(key: PushTemplateKey, locale: Locale, vars: Vars): RenderedPush {
  return TEMPLATES[key][locale](vars);
}
