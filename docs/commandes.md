# Commandes, factures et courriels transactionnels (tâche 12)

Cycle de vie complet des commandes après le paiement (tâche 11) : machine
d'états, espace « Mes commandes » côté client, factures PDF bilingues
numérotées, remboursements (total/partiel) et chaîne de courriels
transactionnels fiable via SES. Entreprise québécoise : factures et parcours
en **français par défaut** (Loi 96), numéros de TPS/TVQ affichés.

## Machine d'états

Source de vérité PARTAGÉE : `packages/core/src/orders.ts`
(`ORDER_STATUS_TRANSITIONS`, `canTransitionOrder`, `ORDER_STATUS_LABELS`,
`isClientCancellable`). Réutilisée par l'API (validation, effets) et le web
(chronologie, bouton « Annuler »).

```
PENDING ──► PAID ──► PROCESSING ──► SHIPPED ──► DELIVERED
   │          │           │            │            │
   └► CANCELLED (avant expédition)      └► REFUNDED / PARTIALLY_REFUNDED
```

- Chemin nominal `PAID → PROCESSING → SHIPPED → DELIVERED`.
- `CANCELLED` n'est atteignable **qu'avant l'expédition** (PENDING, PAID,
  PROCESSING) ; une commande expédiée se **rembourse** (retour), ne s'annule pas.
- `CANCELLED` et `REFUNDED` sont terminaux ; le retour des fonds d'une
  commande annulée se trace dans `refunds` sans changer le statut.

`OrderLifecycleService` (`src/modules/orders/lifecycle`) applique chaque
transition : **validée** (saut illégal → 409), **atomique** (UPDATE
conditionnel sur le statut de départ = verrou anti double-appel),
**historisée** dans `order_status_history` avec l'acteur (client / admin /
système) et l'horodatage, et **déclenche ses effets** (courriel
d'expédition/livraison ; l'annulation restocke et rembourse).

Les transitions d'argent passent par `cancel()` / `RefundService`, jamais par
le `transition()` générique.

## Espace « Mes commandes » (client)

API — Bearer OBLIGATOIRE, strictement limitée au compte connecté :

| Méthode | Route                       | Rôle                                                   |
| ------- | --------------------------- | ------------------------------------------------------ |
| GET     | `/v1/me/orders`             | Liste paginée (curseur)                                |
| GET     | `/v1/me/orders/:id`         | Détail : lignes, taxes ventilées, adresse, chronologie |
| POST    | `/v1/me/orders/:id/cancel`  | Annulation client (avant expédition)                   |
| GET     | `/v1/me/orders/:id/invoice` | Facture PDF (téléchargement authentifié)               |

Une commande d'autrui répond **404** (jamais 403 — on ne révèle pas son
existence).

Web : `apps/web/src/app/[locale]/account/orders` (liste + détail),
composant client `MesCommandes` avec porte de connexion intégrée
(`account-client.ts` : session par jetons dans le corps, rotation du refresh
sur 401). L'annulation client déclenche remboursement intégral + restock +
note de crédit + courriel.

## Remboursements (service interne)

`RefundService.refund(orderId, request)` — **total ou partiel** (par lignes
ou par montant). L'écran admin arrive à la tâche 22 ; le service est le
moteur, prêt et testé. Orchestration idempotente de bout en bout :

1. **Stripe** (hors transaction) — clé d'idempotence ⇒ un rejeu renvoie le
   MÊME remboursement.
2. **`refunds`** — unicité `(provider, external_id)`.
3. **`payments`** — statut REFUNDED / PARTIALLY_REFUNDED.
4. **Restock** optionnel — mouvements `RETURN`, quantité remise en `inventory_levels`.
5. **Statut de commande** — machine d'états + historique daté avec acteur.
6. **Note de crédit** — série `CRN`, PDF, montant ventilé (miroir proportionnel
   de la facture : TPS/TVQ/TVH/TVP sommant exactement au montant remboursé).
7. **Courriel** de remboursement.

Rejouer un remboursement (même id Stripe) ne produit aucun second effet ; la
note de crédit et le courriel sont eux-mêmes idempotents (par `refund_id` /
clé d'idempotence), ce qui ferme aussi la course avec le webhook
`charge.refunded`.

## Factures PDF

`InvoiceService` (`src/modules/orders/invoices`) :

- **Génération asynchrone** à la commande payée (file BullMQ `invoices`,
  `jobId = invoice:<orderId>`). Sans Redis : génération immédiate dans le
  processus (attendue en test).
- **Une facture par commande** — index unique partiel
  `invoices_one_invoice_per_order` (`kind = INVOICE`). Numéro **séquentiel
  sans trou** par série annuelle (`INV-2026`), alloué DANS la transaction
  d'insertion (fonction SQL `allocate_invoice_number`, tâche 04).
- **PDF bilingue** (`pdfkit`) rendu selon la locale du client : en-tête
  entreprise, **numéros d'inscription TPS/TVQ** (réglage
  `settings['entreprise.facturation']`, configurable), adresses, tableau des
  lignes, ventilation des taxes, pied de page avec l'adresse physique.
- **Stockage S3 privé** `invoices` (`InvoiceStorage` ; `InMemory` en
  dev/test). Les octets ne sont jamais servis directement depuis S3 : ils
  transitent par l'API.
- **Note de crédit** générée à chaque remboursement (série `CRN`,
  `invoices.refund_id` unique).

Le **modèle de document** (`invoice-document.ts`) est pur et testé
séparément du rendu PDF : les tests vérifient les mentions FR, la
ventilation TPS/TVQ et les numéros d'inscription sans extraire de texte d'un
PDF.

Téléchargement :

- Authentifié (compte) : `GET /v1/me/orders/:id/invoice`.
- **Lien signé** (courriel, invités inclus) :
  `GET /v1/invoices/:id/download?token=…` — jeton HMAC visant UNE facture,
  expirant (`INVOICE_DOWNLOAD_TTL_HOURS`). Le bucket reste privé.

## Courriels transactionnels (SES)

Gabarits bilingues avec **layout HTML maison réutilisable**
(`src/modules/mail/templates.ts`, `mailLayout`), pied de page portant
l'adresse physique — **transactionnels purs** (aucun contenu marketing,
aucun consentement requis, LCAP) :

- `order_confirmation` (avec lien de facture), `order_payment_failed`,
  `order_cancelled`, `order_refunded`, et `order_shipped` / `order_delivered`
  **prêts** (branchés par la tâche 14).

Envoi via file BullMQ `mail` avec retries ; **journalisation** dans
`notifications`. **Idempotence** : `notifications.idempotency_key` unique — un
webhook ou un job rejoué n'envoie qu'un seul courriel. La langue est toujours
celle du client au moment de l'achat (`order.locale`).

## Robustesse (idempotence)

Chaque effet est rejouable sans duplication :

- **Finalisation** PAID (tâche 11) : UPDATE conditionnel = verrou.
- **Facture** : index unique par commande ; PDF (re)produit s'il manque.
- **Restock / statut** : verrou de transition atomique.
- **Remboursement** : clé d'idempotence Stripe + unicité `external_id`.
- **Courriels** : clé d'idempotence unique.

## Fichiers clés

- `packages/core/src/orders.ts` — machine d'états partagée.
- `src/modules/orders/lifecycle/` — transitions + annulation.
- `src/modules/orders/refunds/` — remboursements.
- `src/modules/orders/invoices/` — document, PDF, stockage, file, courriels de commande.
- `src/modules/orders/customer/` — API « Mes commandes ».
- `src/modules/mail/` — gabarits HTML, file de courriels, idempotence.
- `apps/web/src/components/account/`, `apps/web/src/lib/account-client.ts` — web.

## Tests

- `packages/core/src/orders.test.ts` — table de transitions, libellés.
- `apps/api/test/invoice-document.unit.test.ts` — mentions FR, TPS/TVQ, numéros, `%PDF`.
- `apps/api/test/invoice-sequence.test.ts` — séquence sans trou, **50 commandes concurrentes**.
- `apps/api/test/order-lifecycle.e2e.test.ts` — cycle complet + acteurs, annulation client.
- `apps/api/test/refunds.e2e.test.ts` — total / partiel / par lignes / idempotence.
- `apps/api/test/invoices.e2e.test.ts` — génération + téléchargements (authentifié, lien signé).
- `apps/api/test/order-emails.e2e.test.ts` — langue selon la locale, rejeu → un seul courriel.
