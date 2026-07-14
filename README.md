# Filtration Montréal / Furnace Filters Canada

Plateforme e-commerce maison qui remplace un maximum de services utilisés pour les deux boutiques de filtres à fournaise :

- **furnacefilterscanada.com** — anglais
- **filtrationmontreal.com** — français

Le but est de réduire les coûts liés à l'infrastructure web, d'ajouter des fonctionnalités pertinentes pour cette entreprise et ses clients, et d'améliorer la qualité de vie des utilisateurs du site (clients et compagnie).

## Architecture du dépôt

Monorepo **pnpm workspaces + Turborepo**, TypeScript strict partout.

```
site-ffc/
├── apps/
│   ├── web/          Next.js (App Router) — vitrine bilingue, panier,
│   │                 checkout Stripe, compte client (commandes, colis,
│   │                 identification par photo IA); locale par domaine
│   │                 (filtrationmontreal.com → fr, furnacefilterscanada.com
│   │                 → en), repli par préfixe en dev
│   ├── admin/        Next.js — back-office (RBAC granulaire, MFA
│   │                 obligatoire, audit); catalogue/inventaire, revue IA
│   ├── api/          NestJS — API REST /v1, OpenAPI (/docs), env validé par zod
│   └── mobile/       Expo + expo-router — app iOS/Android
├── packages/
│   ├── core/         Types partagés, schémas zod, constantes métier
│   │                 (tailles de filtres, cotes MERV, provinces/taxes)
│   ├── api-client/   Client TypeScript généré depuis l'OpenAPI de l'API
│   ├── i18n/         Dictionnaires fr/en partagés (next-intl côté web/admin,
│   │                 i18next côté mobile)
│   └── eslint-config/ Config ESLint partagée
├── tsconfig.base.json  Config TypeScript de base (strict)
└── turbo.json          Orchestration des tâches
```

## Prérequis

- **Node.js ≥ 22.12** (testé avec Node 24)
- **pnpm 10** — `npm install -g pnpm@10` (ou corepack)
- Pour l'app mobile : app **Expo Go** sur un appareil, ou simulateur iOS (macOS) / émulateur Android

## Installation

```bash
pnpm install

# Variables d'environnement : copier les exemples (aucun secret dans le dépôt)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/mobile/.env.example apps/mobile/.env

# Base de données locale (PostgreSQL via Docker) + migrations + seed
docker compose up -d postgres
pnpm build --filter @ffc/core
pnpm --filter @ffc/api db:deploy
pnpm --filter @ffc/api db:seed
```

Toutes les valeurs par défaut fonctionnent en local sans modification. Redis
(`docker compose up -d redis`) est optionnel en dev : sans `REDIS_URL`, les
files BullMQ (paiement, ShipStation, suivi de colis, IA) s'exécutent en
traitement immédiat dans le processus API plutôt qu'en file — il devient
obligatoire seulement en production.

## Commandes

Toutes s'exécutent à la racine :

| Commande               | Effet                                                                            |
| ---------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`             | Démarre web (`:3000`), admin (`:3001`) et api (`:4000`)                          |
| `pnpm dev:mobile`      | Démarre le bundler Expo (scanner le QR avec Expo Go, ou `i`/`a` pour simulateur) |
| `pnpm build`           | Build de tous les packages et apps                                               |
| `pnpm lint`            | ESLint sur tout le monorepo                                                      |
| `pnpm typecheck`       | `tsc --noEmit` sur tout le monorepo                                              |
| `pnpm test`            | Tests unitaires et d'intégration (vitest — l'API exige Postgres local)           |
| `pnpm format`          | Prettier sur tout le dépôt                                                       |
| `pnpm generate:client` | Régénère `packages/api-client` depuis l'OpenAPI de l'API                         |

### URLs en développement

- Web : http://localhost:3000 (anglais) · http://localhost:3000/fr (français)
- Admin : http://localhost:3001 (redirige vers `/fr/login`)
- API : http://localhost:4000/v1/health · Swagger : http://localhost:4000/docs
- Mobile + API locale : sur émulateur Android, mettre `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000` dans `apps/mobile/.env`

## Client API généré

L'API NestJS expose son OpenAPI; `packages/api-client` en dérive un client typé
(`openapi-typescript` + `openapi-fetch`) consommé par web, admin et mobile :

```ts
import { createApiClient } from '@ffc/api-client';

const client = createApiClient({ baseUrl: 'http://localhost:4000' });
const { data } = await client.GET('/v1/health');
```

Après tout changement d'endpoint dans `apps/api` : `pnpm generate:client`
(le fichier généré et `apps/api/openapi.json` sont versionnés).

## i18n

Les dictionnaires `fr.json` / `en.json` vivent dans `packages/i18n` et sont
consommés par next-intl (web, admin) et i18next (mobile). Un test vérifie la
parité des clés entre les deux langues. En production, la locale du site web
est déterminée par le domaine; en développement, utiliser le préfixe `/fr`.

## Qualité

- **Hooks de commit** (husky) : `pre-commit` → lint-staged (Prettier), `commit-msg` → commitlint
- **Conventions de commits** : [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `chore:`…)
- **CI locale** : `pnpm lint && pnpm typecheck && pnpm build && pnpm test` doit passer avant de pousser
- L'API **refuse de démarrer** si une variable d'environnement est manquante ou invalide (schéma zod dans `apps/api/src/config/env.ts`)

## Infrastructure et CI/CD

Infrastructure as code (Terraform) en `ca-central-1`, environnements `staging` et
`production` isolés, conteneurisation et pipeline GitHub Actions. Détails,
justifications et procédures dans **[`infra/README.md`](infra/README.md)**.

- **IaC** : `infra/terraform/` (socle `global` + module `environment` + roots par env).
- **Conteneur** : [`apps/api/Dockerfile`](apps/api/Dockerfile) (multi-étapes, non root).
- **Dev local** : `docker compose up -d` (PostgreSQL + Redis) — voir [`docker-compose.yml`](docker-compose.yml).
- **CI** (PR) : lint, typecheck, tests, build, audit, build image — [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- **CD** (main) : build → staging auto → **migrations contrôlées** → production sur
  approbation, via OIDC (aucune clé statique) — [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
- **Runbooks** : [coûts](docs/infra/couts.md), [restauration BD](docs/infra/restauration-bd.md), [rotation de secret](docs/infra/rotation-secret.md).

## Base de données

PostgreSQL 16 + Prisma 6 (`apps/api/prisma/`) : 45 tables, enums partagés avec
`@ffc/core`, montants en cents, numérotation de factures sans trou, audit
append-only, anonymisation Loi 25 outillée. Conventions, décisions et
diagrammes dans **[`docs/database.md`](docs/database.md)** et
[`docs/database-erd.md`](docs/database-erd.md).

## Authentification

Argon2id pour les mots de passe, refresh tokens à rotation (jamais stockés en
clair), connexions sociales Google/Apple, MFA TOTP, mode invité (panier →
compte sans perte de contenu) et droits Loi 25 (export, suppression). Aucun
secret ni jeton en clair en base. Détails et justifications dans
**[`docs/auth.md`](docs/auth.md)**.

## Catalogue et recherche

API publique du catalogue sous `/v1/catalog` : arbre de catégories localisé,
liste filtrable (dimension, MERV, marque, type d'équipement, format de boîte)
triable et paginée par curseur, fiche produit par slug localisé, index des
tailles et équivalences nominal ↔ réel. Recherche full-text Postgres + trigram
tolérante aux fautes, avec normalisation des dimensions (« 16x25x1 », « 16 x
25 x 1 », « 16-25-1 », « 15 3/4 x 24 3/4 »…) et autocomplétion `< 50 ms`.
Détails et décisions dans **[`docs/catalog.md`](docs/catalog.md)**.

Le catalogue initial vient d'une migration ponctuelle et en lecture seule des
deux vitrines BigCommerce : `pnpm --filter @ffc/api bigcommerce:export` puis
`bigcommerce:import`, appariement fr/en par SKU partagé. Mapping et décisions
dans **[`docs/import-mapping.md`](docs/import-mapping.md)**.

## Administration

Back-office (`apps/admin`) pour l'équipe : RBAC granulaire appliqué côté
serveur (le client ne fait que masquer la navigation selon les permissions),
MFA obligatoire, step-up sur les actions sensibles, invitations et journal
d'audit append-only. CRUD produits/variantes/traductions/images, inventaire
et alertes de stock bas, avec revalidation ISR immédiate de la vitrine à
chaque changement. Détails dans **[`docs/admin.md`](docs/admin.md)**.

## Panier et checkout Stripe

Panier compte + invité, checkout Stripe (PaymentIntents + Payment Element),
taxes canadiennes exactes par province, webhooks idempotents. Le client
n'est jamais cru : prix, stock, taxes et totaux sont recalculés côté serveur
à chaque étape depuis la base, et le montant du PaymentIntent sort de cette
cotation. PCI SAQ A — la carte ne transite que par l'iframe Stripe du
navigateur. Détails dans **[`docs/checkout.md`](docs/checkout.md)**.

## Commandes, factures et courriels

Cycle de vie des commandes après paiement (machine d'états partagée dans
`packages/core/src/orders.ts`), espace « Mes commandes » côté client,
factures PDF bilingues numérotées sans trou (obligations québécoises :
TPS/TVQ, français par défaut — Loi 96), remboursements total/partiel, et
courriels transactionnels idempotents via SES. Détails dans
**[`docs/commandes.md`](docs/commandes.md)**.

## Expédition (ShipStation)

Les commandes payées sont poussées vers **ShipStation** (boîte d'envoi écrite
dans la transaction du paiement, drain avec retentatives exponentielles et file
d'échec repoussable), où l'équipe crée les étiquettes et compare les tarifs des
quatre transporteurs (Postes Canada, Nationex, Canpar, Purolator). Le
transporteur et le numéro de suivi reviennent par webhook — avec un polling de
repli si un appel se perd — créent les `shipments` et font passer la commande à
« expédiée ». Procédure de configuration et correspondance des champs dans
**[`docs/shipstation.md`](docs/shipstation.md)**.

## Suivi de colis

Une fois l'étiquette créée, un polling adaptatif interroge les API des mêmes
quatre transporteurs derrière une interface commune (`CarrierTracker`) :
ajouter un transporteur se limite à écrire un adapter. Statuts normalisés,
jalons notifiés une seule fois (courriel + push), passage automatique de la
commande à « livrée » à la livraison de tous les colis. Page cliente
« Mes colis ». Détails dans **[`docs/tracking.md`](docs/tracking.md)**.

## Identification par photo (IA)

Le client photographie la plaque signalétique de son équipement ou le cadre
de son filtre actuel; après consentement et vérification de quota, l'API
ré-encode l'image (métadonnées EXIF/GPS retirées) et l'envoie à un
fournisseur de vision interchangeable (`VisionProvider` — Anthropic/OpenAI)
puis fait correspondre le résultat au catalogue (exact → alias → flou
pg_trgm, ou par dimensions/MERV). Sous le seuil de confiance : file de
révision admin. Photos purgées après 30 jours. Banc d'essai comparatif :
`pnpm --filter @ffc/api ai:bench`. Détails dans **[`docs/ia.md`](docs/ia.md)**.

## État

En construction. Boutique déjà opérationnelle de bout en bout (achat →
expédition → suivi) : fondations du monorepo (tâche 02),
infrastructure/CI-CD (tâche 03), schéma de base de données (tâche 04),
authentification (tâche 05), API catalogue/recherche (tâche 06), vitrine
(tâche 07), import BigCommerce (tâche 08 — testé par fixtures, 2 critères
d'acceptation en attente de jetons API réels), admin et RBAC (tâche 09),
admin catalogue/inventaire (tâche 10), panier/checkout Stripe (tâche 11),
commandes/factures/courriels (tâche 12), intégration ShipStation (tâche 13),
suivi de colis (tâche 14), identification par photo IA (tâche 17) et
identité visuelle (tâche 28) en place.

Reste à faire : socle et parcours d'achat mobile (tâches 15-16), mon
équipement et file de révision IA (tâche 18), compagnon mobile (tâche 19),
rappels de remplacement et réachat (tâche 20), avis clients (tâche 21),
opérations admin — remboursements, clients, promotions, rapports (tâche 22),
intégration QuickBooks (tâche 23), migration finale des données (tâche 24),
redirections et bascule DNS (tâche 25), durcissement sécurité (tâche 26) et
lancement (tâche 27).
