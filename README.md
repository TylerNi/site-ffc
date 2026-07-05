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
│   ├── web/          Next.js (App Router) — vitrine publique bilingue
│   │                 locale par domaine (filtrationmontreal.com → fr,
│   │                 furnacefilterscanada.com → en), repli par préfixe en dev
│   ├── admin/        Next.js — back-office (connexion factice pour l'instant)
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

Toutes les valeurs par défaut fonctionnent en local sans modification.

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

PostgreSQL 16 + Prisma 6 (`apps/api/prisma/`) : 43 tables, enums partagés avec
`@ffc/core`, montants en cents, numérotation de factures sans trou, audit
append-only, anonymisation Loi 25 outillée. Conventions, décisions et
diagrammes dans **[`docs/database.md`](docs/database.md)** et
[`docs/database-erd.md`](docs/database-erd.md).

## Catalogue et recherche

API publique du catalogue sous `/v1/catalog` : arbre de catégories localisé,
liste filtrable (dimension, MERV, marque, type d'équipement, format de boîte)
triable et paginée par curseur, fiche produit par slug localisé, index des
tailles et équivalences nominal ↔ réel. Recherche full-text Postgres + trigram
tolérante aux fautes, avec normalisation des dimensions (« 16x25x1 », « 16 x
25 x 1 », « 16-25-1 », « 15 3/4 x 24 3/4 »…) et autocomplétion `< 50 ms`.
Détails et décisions dans **[`docs/catalog.md`](docs/catalog.md)**.

## État

En construction — fondations du monorepo (tâche 02), infrastructure/CI-CD
(tâche 03), schéma de base de données (tâche 04), authentification (tâche 05)
et API catalogue/recherche (tâche 06) en place.
