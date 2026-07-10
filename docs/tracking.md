# Suivi de colis multi-transporteurs (tâche 14)

Une fois l'étiquette créée (tâche 13), le client veut savoir **où est son
colis** sans quitter notre site. Aucun de nos quatre transporteurs — Postes
Canada, Nationex, Canpar, Purolator — **ne pousse de mise à jour** : tout
repose sur un polling adaptatif de leurs API, derrière une interface commune.

```
shipments (next_poll_at dû) ─► scan (5 min) ─► adapter du transporteur
                                                    │  (auth, parsing, table
                                                    │   de correspondance)
     shipment_events (dédupliqués) ◄────────────────┤
     statut courant + ETA du colis ◄────────────────┘
                │
   transition ─┬─► audit `shipment.status_changed`
               ├─► en livraison / incident ─► courriel + push (1 seule fois)
               └─► livré (TOUS les colis) ─► commande LIVRÉE (tâche 12) + push
```

## L'interface commune

`CarrierTracker` (`src/modules/shipping/tracking/carrier-tracker.ts`) :

- **entrée** : un numéro de suivi ;
- **sortie** : `{ kind: 'ok', events, estimatedDeliveryAt }` ou
  `{ kind: 'not_found' }` (numéro encore inconnu — **normal** les premières
  heures, jamais une erreur) ;
- chaque événement : code source du transporteur, statut **normalisé**
  (`ShipmentStatus` de `@ffc/core`, ou `null` pour un scan purement
  informatif — il reste dans la chronologie sans influencer le statut),
  libellé, lieu, horodatage UTC ;
- les erreurs sont des `CarrierTrackingError` **classées** : `retryable`
  (réseau, 5xx, 429, 408) ou définitive (auth refusée, requête invalide).

Le reste du système (poller, ingestion, notifications, API client) ne connaît
**que** cette interface : ajouter un transporteur = écrire un adapter.

## Les quatre adapters

| Transporteur  | API                                          | Authentification                        | Particularités enfermées dans l'adapter                                                      |
| ------------- | -------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Postes Canada | REST XML (`/vis/track/pin/{pin}/detail`)     | Basic (clés plateforme)                 | fuseaux en abréviation (« EDT »), « No Pin History » (004/016) = inconnu                     |
| Nationex      | REST JSON (`/api/v4/Shipments/{n}/tracking`) | Basic (`customerId:apiKey`)             | codes courts insensibles à la casse, horodatages ISO avec décalage                           |
| Canpar        | SOAP (`trackByBarcodeV2`)                    | user/password **dans le corps**         | heures locales `yyyyMMdd HHmmss` sans fuseau (lues en heure de l'Est), « NO SHIPMENT FOUND » |
| Purolator     | SOAP (`TrackPackagesByPin`)                  | Basic (clé/mot de passe) + `SOAPAction` | `ScanType` en guise de code, dépôts en guise de lieux, liste vide = inconnu                  |

### Tables de correspondance — le cœur de la qualité

Chaque adapter a **son fichier dédié, commenté et testé** :
`adapters/canada-post-codes.ts`, `nationex-codes.ts`, `canpar-codes.ts`,
`purolator-codes.ts`. Chaque code y est documenté ; un code **absent de la
table retourne `null`** (événement conservé, statut inchangé) — jamais une
erreur, jamais une devinette. Les tests verrouillent que chaque table couvre
les jalons essentiels (`PICKED_UP`, `OUT_FOR_DELIVERY`, `DELIVERED`,
`EXCEPTION`) et que tout code vise un statut valide.

Les horodatages passent par `tracking-time.ts` : abréviations de fuseaux
nord-américains, bascule d'heure avancée calculée, dates sans heure ramenées à
**midi UTC** (même jour civil partout en Amérique — utilisé pour les ETA),
entrées malformées rejetées (`null`) plutôt que « roulées » par `Date`.

## Polling adaptatif

L'état vit **en base** (`shipments.next_poll_at`, `poll_failures`) ; le
travail répétable `tracking.scan` (toutes les 5 min) ne fait que récolter les
colis dus. Un redémarrage ne perd donc rien : le job est réenregistré au
démarrage du worker et la base dit quoi reprendre.

| Situation                          | Prochaine interrogation                               |
| ---------------------------------- | ----------------------------------------------------- |
| étiquette créée (tâche 13)         | +15 min (premier repérage)                            |
| créé / pris en charge / en transit | **6 h**                                               |
| **en livraison**                   | **1 h** (le statut peut basculer d'heure en heure)    |
| incident (`EXCEPTION`)             | 12 h — poursuite **prudente**, le colis peut repartir |
| numéro encore inconnu              | 1 h (normal au début, sans compter d'échec)           |
| livré / retourné                   | **arrêt définitif** (`next_poll_at = null`)           |
| adapter non configuré (tâche 01)   | 6 h, avec un avertissement (une fois par processus)   |
| erreur retentable                  | recul exponentiel : 15 min, 30 min, 1 h… ≤ 6 h        |
| erreur définitive                  | 24 h (ne pas marteler une auth refusée)               |

- **Isolation des pannes** : les colis dus sont regroupés **par
  transporteur** ; chaque groupe avance dans sa propre promesse
  (`Promise.allSettled`) et chaque colis encaisse ses erreurs — un Purolator
  en panne ne ralentit ni ne bloque les trois autres.
- **Throttling par transporteur** : `TrackingHttp` sérialise et espace les
  appels de chaque transporteur (30/min ; Purolator 20/min) et respecte les
  429 en repoussant l'appel suivant.
- **Bail de traitement** : le scan repousse `next_poll_at` de 10 min **avant**
  l'appel réseau — deux instances ne repèrent pas le même colis, un processus
  tué laisse le colis retentable.

## Stockage et déduplication

`TrackingIngestService` est la **seule** porte d'écriture :

- chaque événement reçoit une clé calculée (hash `code + horodatage + lieu`),
  unique par colis — le polling relit sans cesse l'historique complet,
  `createMany … skipDuplicates` n'insère jamais deux fois la même ligne. C'est
  aussi ce qui rend la **reprise après panne sans perte** : le repérage
  suivant rattrape d'un coup tous les événements manqués ;
- le **statut courant** est celui de l'événement cartographié le plus récent
  (égalité d'horodatage : le plus avancé l'emporte). La mise à jour est
  conditionnelle au statut lu, et un statut final n'est **jamais** écrasé ;
- toute transition émet l'événement interne : trace d'audit
  `shipment.status_changed` puis jalons.

## Notifications de jalons

| Jalon                                     | Courriel                                                         | Push (Expo, si appareil `user_devices`) |
| ----------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| en livraison                              | `shipment_out_for_delivery`                                      | idem                                    |
| incident                                  | `shipment_exception`                                             | idem                                    |
| livré (**tous** les colis de la commande) | `order_delivered` — envoyé par la machine d'états de la tâche 12 | `order_delivered`                       |

(« Expédié » est déjà notifié par les tâches 12/13 au passage à `SHIPPED`.)

- **Anti-doublon strict** : chaque jalon porte une clé d'idempotence stable
  (`notifications.idempotency_key`, unique) sur les **deux canaux** — le
  polling peut revoir l'événement autant de fois qu'il veut, une seule
  notification part.
- **Préférences** : une désactivation explicite `TRANSACTIONAL × EMAIL` ou
  `× PUSH` est respectée (trace `SKIPPED` qui consomme le jalon).
- Le push est **meilleur effort** (trace `FAILED` sans retentative — le
  courriel reste le canal fiable) ; un jeton `DeviceNotRegistered` supprime
  l'appareil (auto-réparation du carnet).

## « Mes colis »

- `GET /v1/me/shipments` — Bearer obligatoire, strictement les commandes du
  compte ; colis **actifs et historique**, chronologie normalisée (du plus
  récent au plus ancien), libellés localisés, lien vers la commande et vers la
  page publique du transporteur. Pagination par curseur. **La même API
  servira l'app mobile (tâche 19).**
- Web : `/compte/colis` (fr) / `/account/shipments` (en) —
  `apps/web/src/components/account/MesColis.tsx` ; état vide propre, lien
  croisé avec « Mes commandes ».

## Observabilité

- `GET /v1/admin/tracking` (permission `shipments.read`) : par transporteur —
  clés configurées, colis actifs par statut, colis **bloqués** (sans mise à
  jour depuis 5 jours, paramétrable), compteurs du worker (repérages, erreurs,
  latence) ; plus le tableau des colis bloqués les plus anciens.
- **Alerte « échoue en série »** : au 5ᵉ échec consécutif d'un adapter, un log
  `error` part (les alarmes CloudWatch s'y accrochent) ; l'alerte reste levée
  dans la vue admin jusqu'au premier succès. L'écran complet arrive à la
  tâche 22.

## Sans clés API (tâche 01)

Sans jetons réels, les adapters se déclarent non configurés : les colis
restent planifiés (rien n'est perdu), un avertissement part une fois par
processus, et le client garde le **lien public** du transporteur
(`trackingUrlFor`). Dès que les clés arrivent en configuration, le repérage
démarre sans autre changement.

## Variables d'environnement

| Variable                                    | Défaut                              | Note                          |
| ------------------------------------------- | ----------------------------------- | ----------------------------- |
| `CANADA_POST_API_USERNAME` / `_PASSWORD`    | —                                   | clés plateforme Postes Canada |
| `CANADA_POST_BASE_URL`                      | `https://soa-gw.canadapost.ca`      |                               |
| `NATIONEX_CUSTOMER_ID` / `NATIONEX_API_KEY` | —                                   |                               |
| `NATIONEX_BASE_URL`                         | `https://api.nationex.com`          |                               |
| `CANPAR_API_USERNAME` / `_PASSWORD`         | —                                   | compte CanShip                |
| `CANPAR_BASE_URL`                           | `https://canship.canpar.com`        |                               |
| `PUROLATOR_API_KEY` / `_PASSWORD`           | —                                   | clés E-Ship / développeur     |
| `PUROLATOR_BASE_URL`                        | `https://webservices.purolator.com` |                               |
| `PUSH_DRIVER`                               | `log`                               | `expo` en production          |
| `EXPO_ACCESS_TOKEN`                         | —                                   | recommandé avec `expo`        |

Toutes optionnelles (même en production) : chaque transporteur démarre quand
ses clés arrivent.

## Fichiers clés

- `src/modules/shipping/tracking/carrier-tracker.ts` — l'interface commune et les erreurs classées.
- `…/tracking-http.ts` — la seule porte réseau : throttling par transporteur, délais, 429.
- `…/adapters/*.tracker.ts` + `…/adapters/*-codes.ts` — un adapter et sa table par transporteur.
- `…/tracking-time.ts` — fuseaux, heure avancée, ETA à midi UTC.
- `…/tracking-poller.service.ts` — scan, cadences, recul, bail, isolation.
- `…/tracking-ingest.service.ts` — déduplication, statut courant, événement interne.
- `…/tracking-milestones.service.ts` — jalons ; `src/modules/push/` — push Expo.
- `…/customer-shipments.*.ts` — « Mes colis » ; `src/modules/admin/admin-tracking.controller.ts` — observabilité.

## Tests

- `apps/api/test/tracking-mapping.unit.test.ts` — tables de correspondance, déduplication, cadences, fuseaux.
- `apps/api/test/tracking-adapters.unit.test.ts` — les quatre adapters réels sur fixtures anonymisées (auth, parsing, `not_found`, classification des erreurs).
- `apps/api/test/tracking.e2e.test.ts` — les cinq critères d'acceptation : séquences complètes dédupliquées, panne Purolator isolée avec reprise sans perte, jalons notifiés une seule fois malgré les rejeux, « Mes colis », cadence adaptative ; plus le chaînage tâche 13 → 14 et le RBAC de l'observabilité.
