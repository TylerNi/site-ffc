# Intégration ShipStation (tâche 13)

**ShipStation est conservé.** L'équipe d'expédition y crée ses étiquettes et y
compare les tarifs des quatre transporteurs — Postes Canada, Nationex, Canpar et
**Purolator (accessible uniquement via ShipStation)**. Rien ne change dans son
quotidien : c'est notre plateforme qui remplace BigCommerce comme source des
commandes, et qui récupère le résultat de l'expédition.

```
Commande payée ─┬─► shipstation_syncs (boîte d'envoi, MÊME transaction que PAID)
                │
       drain ───┴─► POST /orders/createorder ─► ShipStation ─► étiquette
                                                                   │
       shipments ◄── webhook SHIP_NOTIFY (immédiat) ───────────────┤
                 ◄── polling de repli (toutes les 10 min) ─────────┘
                                    │
                     commande SHIPPED ─► courriel d'expédition (tâche 12)
```

## Poussée des commandes

À la transition `PAID`, la finalisation écrit une ligne `shipstation_syncs`
**dans la transaction même du paiement** (`enqueueShipstationPush`). Une commande
payée ne peut donc pas être « oubliée », même si le processus meurt juste après
le commit : le drain la reprendra.

Un travail répétable (toutes les **15 s** — le critère est « visible en moins
d'une minute ») draine les lignes dues :

1. **recherche par référence externe** `GET /orders?orderNumber=FFC-100042` ;
   trouvée ⇒ on note son `orderId` et on s'arrête (aucun doublon) ;
2. sinon `POST /orders/createorder`. `orderKey` valant aussi notre numéro de
   commande, l'appel est de toute façon un **upsert** côté ShipStation :
   ceinture et bretelles ;
3. la commande passe `PROCESSING` (« en préparation ») chez nous.

### Correspondance des champs

| ShipStation                                   | Nous                                               | Note                                                                |
| --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `orderNumber`                                 | `orders.number`                                    | « FFC-100042 »                                                      |
| `orderKey`                                    | `orders.number`                                    | **Référence externe** : clé de l'upsert                             |
| `advancedOptions.customField1`                | `orders.id` (UUID)                                 | Rattache l'expédition qui revient, même si la commande est renommée |
| `advancedOptions.customField2`                | `orders.locale`                                    | Langue du client                                                    |
| `advancedOptions.storeId`                     | `SHIPSTATION_STORE_ID`                             | Boutique personnalisée                                              |
| `orderDate` / `paymentDate`                   | `paid_at` (repli `placed_at`)                      | ISO 8601                                                            |
| `orderStatus`                                 | —                                                  | `awaiting_shipment`, ou `cancelled` à l'annulation                  |
| `customerEmail`                               | `guest_email` ou `users.email`                     |                                                                     |
| `shipTo` / `billTo`                           | `orders.shipping_address` / `billing_address`      | Instantanés figés à l'achat ; `billTo` retombe sur `shipTo`         |
| `items[].lineItemKey`                         | `order_items.id`                                   | Stable : un rejeu met à jour la ligne                               |
| `items[].sku` / `name`                        | `order_items.sku` / `name_fr`\|`name_en`           | Nom dans la langue du client                                        |
| `items[].unitPrice` / `taxAmount`             | cents ÷ 100                                        | ShipStation ne connaît que les dollars                              |
| `items[].weight`                              | `product_variants.weight_grams`                    | Absent ⇒ **500 g présumés**, signalé en note interne                |
| `amountPaid` / `taxAmount` / `shippingAmount` | `total_cents` / somme des taxes / `shipping_cents` |                                                                     |
| `customerNotes`                               | `orders.customer_note`                             |                                                                     |
| `internalNotes`                               | _calculé_                                          | Livraison US, remise appliquée, poids manquant                      |
| `weight`                                      | Σ (poids unitaire × quantité)                      | Grammes                                                             |

Le code de vérité est `src/modules/shipping/shipstation/shipstation-mapper.ts`
(fonctions pures) ; **toute modification doit être répercutée dans ce tableau**.

## Idempotence, retentatives et débit

- **Idempotence** : recherche par référence externe avant création, `orderKey`
  stable, `shipments.shipstation_shipment_id` unique, `webhook_events`
  unique `(source, external_id)`.
- **Retentatives** : erreurs réseau, 429 et 5xx ⇒ recul exponentiel
  (30 s, 1 min, 2 min, 4 min… plafonné à 15 min), **5 tentatives**. Une erreur
  4xx (payload refusé, clés révoquées) n'est jamais retentée.
- **File d'échec** : après épuisement, la ligne passe `SYNC_FAILED` avec sa
  cause. Elle apparaît dans `/v1/admin/shipstation` avec l'action « repousser ».
- **Bail de traitement** : le drain repousse `next_attempt_at` de 2 minutes
  avant l'appel réseau — deux instances ne traitent pas la même ligne, et un
  processus tué laisse la ligne retentable.
- **Throttling** : le client sérialise ses appels et les espace
  (`SHIPSTATION_RATE_LIMIT_PER_MINUTE`, 40/min par défaut). Les en-têtes
  `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` et un 429 repoussent l'appel
  suivant jusqu'à la réinitialisation du quota.

Sans clés API, **rien n'est perdu** : les lignes restent `PENDING`, aucune
tentative n'est consommée, et l'écran admin l'indique.

## Retour d'expédition

Dès qu'une étiquette est créée, nous recevons le webhook `SHIP_NOTIFY`. Son corps
ne contient **aucune donnée** : seulement une `resource_url` à suivre.

- Le `carrierCode` est **normalisé** vers notre enum `Carrier`
  (`normalizeCarrierCode`, dans `@ffc/core`) : `canada_post`, `CanadaPost`,
  `Canada Post` → `CANADA_POST` ; un transporteur inconnu devient `OTHER`,
  jamais une erreur.
- Une ligne `shipments` est créée par colis (transporteur, service, numéro de
  suivi, coût, poids, dimensions converties en cm). **Plusieurs colis ⇒
  plusieurs lignes, un seul courriel** (clé d'idempotence `order_shipped:<id>`).
- La commande passe `SHIPPED`, ce qui déclenche le courriel d'expédition de la
  tâche 12. Une étiquette annulée (`voided`) n'expédie rien.

### Sécurité du webhook

ShipStation ne signe pas ses appels. L'endpoint est authentifié par un **secret
partagé** comparé à temps constant, accepté dans l'URL (`?token=…`) ou dans
l'en-tête `X-ShipStation-Token`. Sans `SHIPSTATION_WEBHOOK_SECRET`, l'endpoint
répond 503 plutôt que d'ingérer des données non authentifiées. La `resource_url`
suivie doit pointer exactement sur l'origine `SHIPSTATION_BASE_URL` (parade SSRF).

### Polling de repli

Un webhook peut se perdre. Toutes les **10 minutes**, un travail répétable
demande les expéditions créées dans les **6 dernières heures** et les ingère.
Tout étant idempotent, réingérer ne coûte rien ; une expédition rattrapée est
consignée en avertissement (`Polling de repli : n expédition(s) récupérée(s)`).

## Annulations

- Commande annulée **avant** l'étiquette : l'annulation ShipStation est mise en
  file (`operation = CANCEL`) et poussée par le drain (`orderStatus: cancelled`).
  Jamais poussée du tout ⇒ la ligne passe `SKIPPED`.
- Commande **intégralement remboursée** avant l'étiquette (remboursement admin,
  sans passer par l'annulation) : elle n'est jamais poussée — le drain la voit
  `REFUNDED` et passe la ligne à `SKIPPED`. Aucun colis ne part pour une
  commande déjà rendue.
- Commande annulée **après** l'étiquette : l'annulation automatique est
  **BLOQUÉE**. L'API répond `409 LABEL_ALREADY_CREATED` avec un message
  explicite. Le colis existe : il faut le retirer physiquement, puis rembourser
  depuis l'admin (tâche 22). Si la course se produit malgré tout (étiquette
  créée pendant que l'annulation est en file), la ligne bascule `SYNC_FAILED`
  avec la cause — l'échec est visible, jamais silencieux.

### Processus manuel de retrait

1. Dans ShipStation : _Shipments_ → retrouver l'envoi → **Void Label**.
2. Récupérer le colis avant la levée du transporteur.
3. Dans l'admin : rembourser la commande (avec remise en stock).

## Configuration côté ShipStation

1. **Clés API** : _Account Settings → API Settings → API Keys_. Copier la clé et
   le secret dans `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` (AWS Secrets
   Manager en production — jamais dans le dépôt).
2. **Boutique personnalisée** : _Account Settings → Selling Channels → Store
   Setup → Connect a Store → Custom Store_. Nommer « Filtration Montréal / FFC ».
   Relever le `storeId` (dans l'URL) → `SHIPSTATION_STORE_ID`.
3. **Webhook d'expédition** : _Account Settings → Integration Partners →
   Webhooks → Add a Webhook_.
   - Événement : **On Items Shipped** (`SHIP_NOTIFY`).
   - URL : `https://api.filtrationmontreal.com/v1/webhooks/shipstation?token=<SHIPSTATION_WEBHOOK_SECRET>`
   - HTTPS obligatoire (le secret voyage dans l'URL).
4. **Transporteurs** : activer Postes Canada, Nationex, Canpar et Purolator dans
   _Carriers_. Aucune correspondance à saisir : les codes sont normalisés chez
   nous. Un transporteur ajouté plus tard tombe sur `OTHER` (colis suivi quand
   même) — ajouter alors son code dans `CARRIER_BY_FLAT_CODE`
   (`packages/core/src/shipping.ts`) et sa valeur dans l'enum `Carrier`.
5. **Vérification** : passer une commande de test, puis
   `GET /v1/admin/shipstation?status=SYNCED` — la commande doit apparaître en
   moins d'une minute. Créer l'étiquette, vérifier que la commande passe
   « expédiée » et que le courriel part.

## Vue de resynchronisation (admin)

- `GET /v1/admin/shipstation?status=SYNC_FAILED` — file d'échec avec cause,
  tentatives et compteurs par statut (permission `shipments.read`).
- `POST /v1/admin/shipstation/:orderId/retry` — « repousser » : réarme la ligne
  et rejoue **l'opération qui avait échoué** (création ou annulation), avec
  trace d'audit (permission `shipments.write`).

Écran minimal : `apps/admin/src/app/[locale]/(app)/shipstation/page.tsx`.
L'écran d'exploitation complet arrive à la tâche 22.

## Variables d'environnement

| Variable                                         | Défaut                          | Production                        |
| ------------------------------------------------ | ------------------------------- | --------------------------------- |
| `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` | —                               | **obligatoires**                  |
| `SHIPSTATION_WEBHOOK_SECRET`                     | —                               | **obligatoire** (≥ 16 caractères) |
| `SHIPSTATION_BASE_URL`                           | `https://ssapi.shipstation.com` | idem                              |
| `SHIPSTATION_STORE_ID`                           | —                               | recommandé                        |
| `SHIPSTATION_RATE_LIMIT_PER_MINUTE`              | `40`                            | idem                              |

## Fichiers clés

- `packages/core/src/shipping.ts` — libellés, normalisation des transporteurs, liens de repérage.
- `src/modules/shipping/shipstation/shipstation.client.ts` — auth, throttling, classification des erreurs.
- `…/shipstation-mapper.ts` — commande FFC → payload ShipStation (pur).
- `…/shipstation-outbox.ts` — boîte d'envoi (fonctions pures, importées par les commandes : aucun cycle de module).
- `…/shipstation-sync.service.ts` — drain, retentatives, file d'échec, annulation.
- `…/shipstation-shipments.service.ts` — ingestion (webhook + polling).
- `…/shipstation-webhook.controller.ts` — secret partagé, `webhook_events`.
- `src/modules/admin/admin-shipstation.controller.ts` — vue de resynchronisation.

## Tests

- `apps/api/test/shipstation-mapping.unit.test.ts` — mapping, normalisation, recul exponentiel.
- `apps/api/test/shipstation-sync.e2e.test.ts` — poussée, idempotence, panne réseau après création, épuisement → file d'échec, annulations, blocage sur étiquette.
- `apps/api/test/shipstation-shipments.e2e.test.ts` — webhook, sécurité, multi-colis, `voided`, **polling qui rattrape un webhook manqué**.
- `apps/api/test/shipstation-admin.e2e.test.ts` — file d'échec, « repousser », RBAC.
