# Panier et checkout Stripe (tâche 11)

Cœur transactionnel de la plateforme : panier compte + invité, checkout
Stripe (PaymentIntents + Payment Element), taxes canadiennes exactes,
webhooks idempotents. Périmètre : **web** (le mobile arrive à la tâche 16,
le cycle de vie post-paiement — factures, courriels riches — à la tâche 12).

## Principes non négociables

- **Le client n'est jamais cru.** Prix, stocks, totaux, taxes, remises :
  tout est recalculé côté serveur à chaque opération, depuis la base. Le
  montant du PaymentIntent sort de la cotation serveur du panier revalidé.
- **PCI SAQ A.** La carte n'existe QUE dans le Payment Element (iframe
  Stripe) du navigateur. L'API manipule des identifiants opaques
  (PaymentIntent, charge) et ne retient que marque + 4 derniers chiffres.
  Revue automatisée : `apps/api/test/pci-no-card-data.e2e.test.ts` (schéma
  sans colonne de carte, aucun PAN en base après un achat, champs de carte
  postés rejetés par la whitelist de validation).
- **Idempotence partout.** Un webhook rejoué, un double clic, un webhook
  et un retour client simultanés : zéro double effet (commande, stock,
  coupon, courriel).

## Panier (`/v1/cart`)

| Méthode | Route                       | Rôle                                         |
| ------- | --------------------------- | -------------------------------------------- |
| GET     | `/v1/cart`                  | État complet, revalidé et réconcilié         |
| POST    | `/v1/cart/items`            | Ajoute une variante (quantités additionnées) |
| PATCH   | `/v1/cart/items/:variantId` | Fixe la quantité                             |
| DELETE  | `/v1/cart/items/:variantId` | Retire la ligne                              |

- **Identité** : Bearer (compte) OU en-tête `X-Cart-Token` (invité — jeton
  opaque 256 bits émis à la première addition, stocké HACHÉ dans
  `carts.guest_token`, TTL glissant 30 jours). Bearer présent ⇒ le compte
  prime ; la fusion invité→compte ne se fait qu'au login (tâche 05).
- **Auth facultative** : routes marquées `@OptionalAuth()` — sans en-tête
  la requête passe en anonyme, mais un Bearer fourni est vérifié
  strictement (jeton expiré = 401 franc, jamais d'invité silencieux).
- **Réconciliation** : à CHAQUE lecture, les lignes mortes sont retirées
  (produit dépublié → `UNAVAILABLE`, épuisé → `OUT_OF_STOCK`), les
  quantités rabattues au stock vendable, les prix relus ; chaque écart est
  signalé UNE fois dans `changes` puis le panier est propre.
- Jeton inconnu/expiré : panier vide, jamais d'erreur (auto-guérison — un
  ré-ajout émet un nouveau jeton).
- Stock vendable = `quantity_on_hand − quantity_reserved`
  (`inventory_levels`) — même règle que le catalogue.

## Checkout (`/v1/checkout`)

### `POST /v1/checkout/session`

Entrée : courriel (invité), adresse de livraison (ou `shippingAddressId`
du carnet), coupon, note. Le serveur :

1. revalide le panier — le moindre écart répond **409 `CART_CHANGED`**
   avec le détail (le client réaffiche puis re-soumet) ;
2. valide l'adresse avec `checkoutAddressSchema` (@ffc/core) : formats
   postaux CA (`A1A 1A1`, normalisé) / US (`12345[-6789]`), province ou
   état cohérent avec le pays ;
3. valide le coupon (période, plafonds global et par client — les invités
   sont plafonnés par courriel de commande) ;
4. cote : sous-total → remise répartie par ligne (plus fort reste) →
   livraison → taxes par ligne (voir plus bas) → total ;
5. crée ou RECOTE la commande `PENDING` du panier (`orders.cart_id`
   unique ; `order_items` immuables ⇒ remplacés, jamais modifiés) —
   numéro alloué une seule fois ;
6. crée ou met à jour le PaymentIntent (montant = total serveur,
   metadata `orderId`/`orderNumber`/`cartId`, `automatic_payment_methods`
   ⇒ cartes + Apple Pay + Google Pay + 3DS automatique) ;
7. répond `clientSecret` + récapitulatif complet.

Re-soumettre (autre adresse, autre coupon) recote la MÊME commande et met
à jour le MÊME intent tant qu'il est payable.

### `POST /v1/checkout/result`

Appelé par la page de succès avec `paymentIntentId` + `clientSecret` (la
preuve de possession — impossible de lire la commande d'autrui). Si Stripe
dit « payé » et que le webhook n'est pas encore passé, la **finalisation
idempotente est exécutée ici** : la page de succès n'attend jamais.

## Livraison

Décision arrêtée (plan §5.5) : **Canada gratuit** partout ; **États-Unis =
frais fixes** en cents CAD, réglage `expedition.frais_fixes_us_cents`
(table `settings`, seed 2500, repli codé 2500, modifiable en admin —
tâche 22). Coupon `FREE_SHIPPING` ⇒ livraison à 0. Autre pays : refusé à
la validation d'adresse. Devise unique v1 : CAD, y compris pour les
commandes américaines (taxes 0).

## Taxes canadiennes

Interface **`TaxCalculator`** (@ffc/core) injectée par le jeton
`TAX_CALCULATOR` — brancher Stripe Tax plus tard (point ouvert n° 6) =
fournir une autre implémentation, rien d'autre ne bouge.

Implémentation v1 : `CanadianTaxCalculator`, tables maison dans
`packages/core/src/taxes.ts` (source de vérité unique des taux) :

| Destination    | Taxes                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| QC             | TPS 5 % + TVQ 9,975 % (chacune sur la base avant taxe)                                       |
| ON             | TVH 13 %                                                                                     |
| NB, NL, PE     | TVH 15 %                                                                                     |
| **NS**         | **TVH 14 %** — en vigueur depuis le 2025-04-01 (le brief citait 15 %, antérieur à la baisse) |
| AB, NT, NU, YT | TPS 5 %                                                                                      |
| BC             | TPS + TVP 7 % · SK : TPS + TVP 6 % · MB : TPS + TVD 7 %                                      |
| États-Unis     | Aucune taxe (frais fixes de livraison)                                                       |

Règles d'arrondi : chaque composante est calculée **par ligne** sur la
base APRÈS remise, en arithmétique entière (bigint, half-up — jamais de
flottant) ; les totaux de commande sont la somme des lignes. La livraison
est une ligne taxable à part. Ventilation figée dans
`orders.tax_{gst,qst,hst,pst}_cents` (TVP/TVD → `pst`) et
`order_items.tax_cents`.

## Finalisation atomique (commande payée)

`OrderFinalizerService.finalizePaidOrder(orderId, intent)` — déclenchée
par le webhook `payment_intent.succeeded` ET/OU par `/checkout/result` ;
le premier arrivé gagne (UPDATE conditionnel `PENDING → PAID` = verrou),
l'autre ne fait rien. Dans UNE transaction :

1. transition `PENDING → PAID` (`updateMany … WHERE status='PENDING'`) ;
2. **stock** : `UPDATE inventory_levels SET quantity_on_hand -= q WHERE
quantity_on_hand − quantity_reserved ≥ q` — l'échec (0 ligne) annule
   TOUT ; mouvement `SALE` consigné par ligne ;
3. coupon consommé (`times_redeemed` + `coupon_redemptions`) ;
4. paiement `SUCCEEDED` + détails de reçu (marque, last4, URL Stripe) ;
5. panier `CONVERTED`, historique de statut consigné.

Après commit : courriel `order_confirmation` (une seule fois — le gagnant
du verrou) + trace d'audit.

**Stock insuffisant après paiement** (deux checkouts sur le dernier
article) : la transaction est annulée, la commande passe `CANCELLED`
(note interne explicite), un **remboursement intégral automatique** part
chez Stripe et est consigné dans `refunds`. Le client voit un message
clair sur la page de succès (`cancelled_insufficient_stock`). Testé en
vraie concurrence : `apps/api/test/checkout-concurrency.e2e.test.ts`.

Un remboursement (total ou partiel) ne remet JAMAIS le stock en vente
automatiquement — la remise en inventaire est une décision d'opération
(retour physique), tâches 12/22.

## Webhooks Stripe (`POST /v1/webhooks/stripe`)

1. **Signature vérifiée** sur le corps brut (`rawBody`) avec
   `STRIPE_WEBHOOK_SECRET` — 400 sinon.
2. **Idempotence** : enregistrement dans `webhook_events` sous l'unicité
   `(source, external_id)` — un rejeu répond `200 {duplicate:true}` sans
   retraitement. Statuts : `RECEIVED → PROCESSED | IGNORED | FAILED`.
3. **File BullMQ** `stripe-webhooks` (Redis, `REDIS_URL`) : l'API
   enregistre et répond ; le service **workers** (`worker.ts`) consomme
   avec 5 retentatives exponentielles. Sans Redis (dev/test) : traitement
   dans le processus API.

Événements couverts : `payment_intent.succeeded` (finalisation),
`payment_intent.payment_failed` (échec consigné, la commande reste
payable), `charge.refunded` (upsert des remboursements, commande
`REFUNDED`/`PARTIALLY_REFUNDED`), `charge.dispute.created` (audit + note
interne). Tout le reste : `IGNORED`.

En local :

```bash
stripe listen --forward-to localhost:4000/v1/webhooks/stripe
stripe trigger payment_intent.succeeded   # ou rejouer depuis le Dashboard
```

## Parcours web

- **Fiche produit** : bouton « Ajouter au panier » par variante (stock
  revalidé à l'ajout, messages d'erreur inline).
- **/cart · /panier** : lignes avec steppers de quantité, retraits,
  bandeau des écarts (produit retiré, prix changé…), sous-total ; le jeton
  invité vit dans `localStorage` (`ffc.cartToken`) — panier persistant
  entre visites ; badge d'en-tête synchronisé (`ffc:cart-updated`).
- **/checkout · /caisse** : une page, deux étapes — coordonnées + adresse
  (validation locale = mêmes règles @ffc/core que le serveur, sélecteurs
  province/état) puis **Payment Element** (cartes, Apple Pay, Google Pay,
  3DS automatique, localisé fr/en). « Modifier » recote la même commande.
  Erreurs de paiement affichées inline (message Stripe localisé).
- **/checkout/success · /caisse/confirmation** : interroge
  `/checkout/result`, affiche le récapitulatif (numéro, lignes, taxes
  ventilées, adresse) ; `processing` re-vérifie automatiquement ; échec ⇒
  retour à la caisse ; stock insuffisant ⇒ message d'annulation-
  remboursement. Pages panier/caisse : `noindex`.

Variables d'environnement web : `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
(clé publiable seulement). API : `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `REDIS_URL` — obligatoires en production,
facultatifs en dev (sans clés : la caisse répond 503 et l'affiche
proprement, tout le reste fonctionne).

## Cartes de test (mode test Stripe)

| Scénario        | Numéro              |
| --------------- | ------------------- |
| Succès          | 4242 4242 4242 4242 |
| Refus générique | 4000 0000 0000 0002 |
| 3DS obligatoire | 4000 0027 6000 3184 |

## Tests

- `packages/core/src/taxes-checkout.test.ts` — taux par province, arrondis
  au cent, répartition de remise, formats postaux.
- `apps/api/test/cart.e2e.test.ts` — panier invité/compte, revalidation,
  retraits propres, persistance.
- `apps/api/test/checkout.e2e.test.ts` — totaux exacts QC/ON/NS/AB/BC/US,
  coupons, parcours complets (succès, refus, 3DS), garde-fous.
- `apps/api/test/stripe-webhooks.e2e.test.ts` — signature, rejeu sans
  double effet, remboursements, litiges.
- `apps/api/test/checkout-concurrency.e2e.test.ts` — dernier article en
  parallèle ; webhook + retour client simultanés.
- `apps/api/test/pci-no-card-data.e2e.test.ts` — revue PCI automatisée.
- `apps/api/test/addresses.e2e.test.ts` — carnet d'adresses du compte.

Les e2e utilisent un **faux Stripe en mémoire** (même surface que
`StripeService`) ; la **vérification de signature des webhooks reste le
vrai code du SDK** (payloads signés avec `generateTestHeaderString`).
Contre un vrai compte Stripe test : renseigner les clés, lancer
`stripe listen`, payer avec les cartes ci-dessus.
