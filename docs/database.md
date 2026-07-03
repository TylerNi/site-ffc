# Base de données — conventions, migrations et décisions

> Tâche 04. Schéma : [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) ·
> Diagrammes : [database-erd.md](./database-erd.md) (générés — `pnpm --filter @ffc/api db:erd`).

PostgreSQL 16 (RDS en production, Docker en local) piloté par **Prisma 6**
depuis `apps/api`. Extensions requises : `pg_trgm` (recherche floue) et
`citext` (unicité insensible à la casse) — activées par la migration
initiale, préinstallées sur RDS.

## Démarrage rapide

```bash
docker compose up -d postgres          # Postgres local (ffc/ffc, base ffc_dev)
pnpm build --filter @ffc/core          # le seed importe @ffc/core
cd apps/api
cp .env.example .env                   # DATABASE_URL + TEST_DATABASE_URL
pnpm db:reset                          # rejoue les migrations + seed (destructif)
pnpm test                              # tests d'intégration (base ffc_test dédiée)
```

Scripts utiles (`apps/api/package.json`) : `db:migrate` (nouvelle migration),
`db:deploy` (CI/production, non interactif), `db:seed`, `db:erd`.

## Conventions

| Sujet        | Convention                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables       | `snake_case` pluriel (`product_variants`) via `@@map` ; modèles Prisma en PascalCase singulier                                                                                                                               |
| Colonnes     | `snake_case` via `@map` ; champs Prisma en camelCase                                                                                                                                                                         |
| Identifiants | UUID **v7** (`@default(uuid(7))`, type `uuid`) : ordonnés dans le temps, favorables aux index B-tree                                                                                                                         |
| Horodatage   | `created_at` partout ; `updated_at` (`@updatedAt`) sur les tables mutables seulement — les instantanés (`order_items`) et journaux (`audit_logs`) n'en ont pas                                                               |
| Montants     | **Toujours en cents (`Int`)** avec `currency` explicite (`CAD`/`USD`). Jamais de flottants. Les dimensions physiques (pouces, cm) utilisent `Decimal`                                                                        |
| Enums        | Types Postgres natifs, nommés `snake_case`, valeurs `SCREAMING_SNAKE_CASE`. Source de vérité TypeScript : `packages/core/src/enums.ts`, miroir exact du schéma Prisma vérifié par le test `apps/api/test/enums-sync.test.ts` |
| Suppressions | `Cascade` pour les possessions pures (adresses, items…), `SetNull` pour préserver l'historique (commandes, avis), `Restrict` pour les documents financiers et logistiques (paiements, factures, expéditions)                 |
| i18n         | Tables `*_translations` (produits, catégories) avec `@@unique([locale, slug])` : slugs indépendants par langue pour les URL des deux vitrines                                                                                |

## Stratégie de migration

- **Une migration = un changement revu.** Développement : `pnpm db:migrate`
  (nom en `snake_case` descriptif). Production/staging : `prisma migrate deploy`
  exécuté comme étape contrôlée du pipeline (tâche ECS ponctuelle avant le
  basculement du service — voir `apps/api/scripts/migrate.mjs` et
  `.github/workflows/deploy.yml`). Jamais de `db push` hors prototypage local.
- **Jamais de modification d'une migration appliquée** : toute correction est
  une nouvelle migration.
- **SQL manuel assumé** : ce que Prisma ne modélise pas vit dans des
  migrations éditées à la main (`--create-only`) — contraintes `CHECK`,
  triggers, fonctions, séquences. La migration
  `contraintes_et_triggers` porte l'intégrité critique ; Prisma n'y touche
  pas (objets hors de son modèle, aucune dérive détectée).
- Les tests rejouent **toutes** les migrations depuis zéro à chaque exécution
  (`migrate reset` sur la base `ffc_test`) : la chaîne de migration reste
  toujours valide.
- Évolutions anticipées sans refonte : multi-entrepôt (ajouter `location_id`
  à `inventory_levels`/`inventory_movements`), abonnements Stripe Billing
  (voir plus bas), nouveaux transporteurs et fournisseurs de paiement
  (enums extensibles + colonnes `external_id` génériques).

## Décisions clés

### 1. Numérotation de factures **sans trou** (`invoices` + `invoice_counters`)

Obligation comptable : chaque série de factures doit être séquentielle et
sans trou. Les séquences Postgres ne conviennent pas (un `ROLLBACK` y crée
un trou définitif).

**Implémentation** — table de compteurs verrouillée :

- `invoice_counters(series PK, last_value)` : une ligne par série annuelle —
  `INV-2026` (factures), `CRN-2026` (notes de crédit).
- Fonction SQL `allocate_invoice_number(series)` : `INSERT … ON CONFLICT DO
UPDATE SET last_value = last_value + 1 RETURNING last_value`. Le **verrou de
  ligne** sérialise les transactions concurrentes ; un rollback **restitue**
  le numéro (le suivant le reprend).
- Règle d'or : allouer **dans la même transaction** que l'insertion de la
  facture — helper `allocateInvoiceNumber(tx, series)`
  (`apps/api/src/database/invoice-number.ts`). Une allocation hors
  transaction créerait un trou en cas d'échec d'insertion.
- Filets en base : `@@unique([series, sequence])`, `@@unique([number])`,
  `CHECK (sequence >= 1)`.
- Une facture annulée passe à `VOIDED` mais **garde son numéro** (jamais
  réutilisé, jamais sauté). Les remboursements produisent des notes de
  crédit (`kind = CREDIT_NOTE`, série `CRN-…`) plutôt que des suppressions.
- Sous concurrence, le débit est celui d'une ligne verrouillée (~centaines
  de factures/s) — largement suffisant, et le verrou ne s'applique que par
  série.

Vérifié par `apps/api/test/invoice-sequence.test.ts` : 12 transactions
parallèles → 1..12 sans trou ; rollback → numéro repris ; séries
indépendantes.

À l'inverse, les **numéros de commande** (`FFC-100042`) n'ont aucune
obligation de continuité : séquence native `order_number_seq` (des trous
peuvent apparaître, l'unicité suffit) — `allocateOrderNumber(tx)`.

### 2. Anonymisation de compte — Loi 25 (`anonymizeUser`)

Le droit à l'effacement se heurte à l'obligation de conserver les pièces
comptables (ARC/Revenu Québec, ~6 ans). Réconciliation : **anonymiser, pas
supprimer**.

| Donnée                                                                                         | Sort                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                                                                        | Ligne conservée (statut `ANONYMIZED`) ; courriel remplacé par `anonyme+<id>@compte-supprime.invalid`, noms/téléphone/mot de passe/MFA/identifiants sociaux et Stripe effacés          |
| Adresses, appareils, jetons, paniers, équipements, plans de rappel, notifications, préférences | **Supprimés**                                                                                                                                                                         |
| Identifications IA                                                                             | **Supprimées** (les photos d'équipement sont des renseignements personnels) ; clés S3 renvoyées pour purge                                                                            |
| Commandes                                                                                      | **Conservées** (montants, taxes, lignes intactes) mais détachées (`user_id` nul) ; adresses figées réduites à `{ ville, province, RTA, pays }` ; courriel/IP/user-agent/notes effacés |
| Factures / expéditions                                                                         | Lignes conservées ; les PDF S3 (facture, étiquette — ils contiennent nom et adresse) sont à purger : clés renvoyées et effacées des lignes                                            |
| Avis                                                                                           | Conservés (contenu public) mais détachés et sans nom d'auteur                                                                                                                         |
| `audit_logs`                                                                                   | Intouchés (append-only) ; rétention limitée et justifiée (prévention de la fraude) — purge planifiée après 3 ans                                                                      |

Outillage :

- Fonction transactionnelle `anonymizeUser(prisma, userId, options)` —
  `apps/api/src/database/anonymize-user.ts` (utilisée par l'admin en
  tâche 22, exposée au client en tâche 05).
- CLI opérateur : `pnpm exec tsx --env-file=.env scripts/anonymize-user.ts
<courriel|uuid> [--reason "…"]` — imprime les clés S3 à purger.
- Chaque exécution écrit une ligne `user.anonymize` dans `audit_logs`.

Un compte **sans commande** peut, lui, être supprimé physiquement
(`prisma.user.delete` — les cascades font le ménage) ; dès qu'une commande
existe, seul le chemin d'anonymisation est permis.

### 3. `order_items` : instantanés d'achat immuables

Chaque ligne copie à l'achat tout ce qui fait foi : `sku`, noms **fr et en**
(factures bilingues), taille nominale, MERV, format de boîte, prix unitaire,
remise, taxes et totaux en cents. Modifier ou supprimer le produit ensuite ne
change rien aux commandes passées (`variant_id`/`product_id` sont des
références lâches `SetNull`).

Un **trigger** (`order_items_immutable`) rejette tout `UPDATE` des colonnes
copiées — seule la mise à `NULL` des références lâches par les FK reste
permise. Corriger une commande = remboursement + note de crédit, jamais une
retouche de ligne.

### 4. `audit_logs` : append-only, sans clés étrangères

Un journal d'audit ne doit jamais être réécrit : trigger
`audit_logs_append_only` qui rejette `UPDATE` et `DELETE` (y compris en SQL
brut — seul un superutilisateur peut le contourner, ce que l'application
n'est pas). Les références (`actor_id`, `entity_id`) sont **volontairement
sans FK** : une suppression ailleurs ne peut pas modifier une ligne d'audit,
et le courriel de l'acteur y est figé.

### 5. Idempotence des webhooks (`webhook_events`)

`@@unique([source, external_id])` : Stripe/ShipStation/SES peuvent livrer
plusieurs fois le même événement, il n'est enregistré (et donc traité)
qu'une seule fois. Le traitement (tâche 11+) fera :
`INSERT … ON CONFLICT DO NOTHING` → si aucune ligne insérée, événement déjà
vu, on répond 200 sans retraiter.

### 6. Recherche floue — `pg_trgm`

Index GIN trigram sur `product_translations.name` et
`equipment_models.model_number` (+ GIN standard sur le tableau `aliases`).
Requêtes de référence dans `apps/api/test/trigram-search.test.ts` :
`word_similarity()` pour les noms longs, opérateur `%` pour les numéros de
modèle courts. Index B-tree de filtrage sur dimensions nominales, MERV,
`nominal_label`, marque, statuts (commande, expédition), `tracking_number`,
files de travail (`status, next_poll_at`), etc.

### 7. Prêt pour Stripe Billing (abonnements) — sans refonte

Points d'ancrage déjà en place :

- `users.stripe_customer_id` (unique) — le client Stripe est l'objet pivot
  de Billing ;
- `payments` génériques : `provider` (enum extensible) + `external_id`
  avec unicité `(provider, external_id)` — une facture d'abonnement Stripe
  devient un paiement ordinaire ;
- `orders.channel = SUBSCRIPTION` — les commandes générées par un
  renouvellement se distinguent sans nouvelle table ;
- `replenishment_plans` (tâche 20) porte déjà la cadence : y ajouter
  `stripe_subscription_id` suffira à lier un abonnement Billing ;
- montants en cents + devise partout (le modèle de Stripe).

### 8. Divers

- **Emails et codes promo insensibles à la casse** : `citext`
  (`users.email`, `orders.guest_email`, `coupons.code`).
- **Paniers invités** : `carts.guest_token` (jeton opaque du cookie) ;
  `CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)`.
- **Adresses de commande figées en JSONB** (+ `shipping_province` extrait
  pour les rapports de taxes) — le carnet d'adresses peut changer sans
  altérer l'historique. Taxes ventilées par type (`gst/qst/hst/pst`,
  RST du Manitoba dans la colonne PST) pour QuickBooks (tâche 23).
- **Suivi de colis** : `shipment_events` dédupliqués par
  `(shipment_id, dedup_key)` — le polling adaptatif (tâche 14) peut rejouer
  sans doublon ; file de travail indexée `(status, next_poll_at)`.
- **Rétention IA** : `ai_identifications.purge_at` indexé — un travail
  planifié (tâche 17) purge image S3 et extraction à l'échéance (Loi 25,
  minimisation).
- **RBAC** : `users.role` = rôle système grossier ; le détail
  (rôles/permissions/attributions) vit dans les tables dédiées (tâche 09).
- **CHECKs** : quantités > 0, montants ≥ 0, `rating` 1–5, pourcentage de
  coupon 1–100 — le dernier rempart sous les validations applicatives.

## Tests d'intégration

`pnpm --filter @ffc/api test` — vitest, base **`ffc_test`** dédiée (jamais
`ffc_dev`) : le `globalSetup` exécute `prisma generate`, **rejoue toutes les
migrations** (`migrate reset --force`) puis seed. Couverture : synchronisation
des enums, unicité webhooks, immuabilité `order_items`, append-only
`audit_logs`, séquence de factures sous concurrence et rollback, contraintes
CHECK, recherche trigram, anonymisation Loi 25, idempotence du seed. En CI, le
job `quality` fournit un Postgres 16 de service.

## Seeds

`pnpm db:seed` (idempotent — relançable sans reset) : 3 marques, 40 produits
bilingues (tailles courantes 1/4/5 po × MERV 8/11/13), 110 variantes
(boîtes de 1/4/6/12) avec inventaire, 6 modèles d'équipement avec alias et
compatibilités, 2 fournisseurs, RBAC de base, un admin
(`admin@filtrationmontreal.com`), un client de test
(`client.test@example.com`) avec commande payée → facturée → expédiée
(suivi Postes Canada), avis approuvé, plan de rappel et identification IA en
file de révision. Mots de passe seedés = développement uniquement.
