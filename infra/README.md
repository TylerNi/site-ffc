# Infrastructure — Filtration Montréal / Furnace Filters Canada

Infrastructure as code (Terraform) pour la plateforme e-commerce, **entièrement en
`ca-central-1`** (résidence des données au Canada — Loi 25). Deux environnements
isolés (`staging`, `production`) et un socle `global` partagé.

## Choix techniques (et pourquoi)

### Terraform (plutôt qu'AWS CDK)

On pilote **AWS _et_ Cloudflare _et_ (à terme) d'autres SaaS** depuis le même
outil. CDK ne gère qu'AWS (CloudFormation) ; Terraform a des providers de
première classe pour Cloudflare, AWS et bien d'autres, un flux
`plan`/`apply` explicite, un état isolable par environnement, et un vaste
écosystème de modules. C'est le meilleur ajustement pour une infra multi-fournisseurs.

### ECS Fargate (plutôt qu'App Runner)

Il faut **deux services distincts issus de la même image** : `api` (HTTP) et
`workers` (files BullMQ, **sans** serveur HTTP, permanent). App Runner est
orienté service HTTP piloté par les requêtes et gère mal un worker permanent
non-HTTP ; ECS Fargate lance deux services avec des **commandes différentes**
(`node dist/main.js` vs `node dist/worker.js`), un autoscaling fin par service,
une intégration VPC native et une tâche de migration ponctuelle. Sans serveur à
gérer (Fargate), ce qui maîtrise les coûts.

## Arborescence

```
infra/terraform/
├── global/                     Ressources partagées (une seule fois) :
│                               ECR, OIDC GitHub→AWS, zones Cloudflare + WAF,
│                               SES (DKIM/SPF/DMARC), secrets DSN Sentry.
├── modules/
│   └── environment/            Un environnement complet : VPC 3 tiers, RDS,
│                               ElastiCache, S3+CloudFront, ECS (api/workers/
│                               migrate), Secrets Manager, IAM, observabilité,
│                               DNS Cloudflare (api.*, validation ACM).
└── environments/
    ├── staging/                Compose le module (dimensionnement modeste).
    └── production/             Compose le module (Multi-AZ, HA).
```

Conteneurisation (hors `infra/`) : [`apps/api/Dockerfile`](../apps/api/Dockerfile)
(multi-étapes, non root) et [`docker-compose.yml`](../docker-compose.yml) (Postgres

- Redis locaux). CI/CD : [`.github/workflows/`](../.github/workflows/).

## Topologie (par environnement)

```
Internet
   │  (DNS + proxy + WAF + TLS strict)
Cloudflare ── api.<domaine> ──▶ ALB (public, HTTPS via ACM, ingress limité aux IP Cloudflare)
                                   │
                          ┌────────┴─────────┐  VPC ca-central-1 (2 AZ)
                          │  Sous-réseaux :   │
                          │  public  (ALB, NAT)
                          │  app     (ECS api + workers, sans IP publique)
                          │  data    (RDS, Redis — sans route Internet)
                          └───────────────────┘
   S3 (product-images ▶ CloudFront/OAC · ai-photos 30j · invoices) · Secrets Manager · SES
```

## Prérequis

- Terraform ≥ 1.6, AWS CLI v2 configuré (`aws sso login` ou profil), `jq`.
- Un compte AWS (voir « Isolation » plus bas), un compte Cloudflare avec les deux
  domaines ajoutés, un jeton API Cloudflare (`Zone:Edit`, `DNS:Edit`).
- Ne jamais committer de secret. Le jeton Cloudflare passe par
  `export TF_VAR_cloudflare_api_token=...`.

## Amorçage de l'état

L'état est distant (S3 chiffré + verrou DynamoDB). À créer **une fois** avant le
premier `init` :

```bash
aws s3api create-bucket --bucket <votre-ffc-tfstate> \
  --region ca-central-1 --create-bucket-configuration LocationConstraint=ca-central-1
aws s3api put-bucket-versioning --bucket <votre-ffc-tfstate> \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket <votre-ffc-tfstate> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
aws dynamodb create-table --table-name ffc-tfstate-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region ca-central-1
```

Renseigner le nom du bucket dans les `backend.tf` (ou, mieux, via
`terraform init -backend-config=backend.hcl`).

## Ordre de déploiement

```bash
# 1) Socle global (ECR, OIDC, Cloudflare, SES, Sentry)
cd infra/terraform/global
cp terraform.tfvars.example terraform.tfvars   # renseigner github_owner, cloudflare_account_id
export TF_VAR_cloudflare_api_token=...
terraform init && terraform apply

# 2) Pousser une PREMIÈRE image dans ECR (sinon les services ECS n'ont rien à lancer)
#    — soit en lançant le workflow « Deploy » une fois, soit manuellement :
aws ecr get-login-password --region ca-central-1 | docker login --username AWS --password-stdin <ecr_url>
docker build -f apps/api/Dockerfile -t <ecr_url>:latest . && docker push <ecr_url>:latest

# 3) Staging, puis production
cd ../environments/staging
cp terraform.tfvars.example terraform.tfvars     # renseigner tf_state_bucket, alert_email
terraform init && terraform apply
cd ../production && terraform init && terraform apply
```

`terraform output github_environment_variables` (dans chaque environnement) donne
exactement les variables à coller dans GitHub (ci-dessous).

## CI/CD (GitHub Actions)

- **[`ci.yml`](../.github/workflows/ci.yml)** (sur PR) : lint, typecheck, tests,
  build, audit des dépendances (`pnpm audit`), et build de l'image Docker (sans push).
- **[`deploy.yml`](../.github/workflows/deploy.yml)** (sur push `main`) : build +
  push de l'image (taguée par SHA), puis **staging automatique**, puis
  **production sur approbation**. La même image est promue de staging vers prod.
  L'ordre par environnement (workflow réutilisable
  [`_deploy-env.yml`](../.github/workflows/_deploy-env.yml)) :
  1. **Migrations** — tâche ECS ponctuelle et **contrôlée**, exécutée avec la
     nouvelle image **avant** tout basculement ([`run-migrations.sh`](../.github/scripts/run-migrations.sh)).
  2. Déploiement des services `api` puis `workers`.

### OIDC (aucune clé statique)

Le socle global crée le provider OIDC GitHub et trois rôles :
`ffc-github-build` (push ECR depuis `main`), `ffc-github-deploy-staging`,
`ffc-github-deploy-production` (confiance liée à l'**environnement** GitHub).

### Configuration GitHub à faire une fois

- **Variable de dépôt** : `AWS_BUILD_ROLE_ARN` = sortie `github_build_role_arn` du global.
- **Environnements** `staging` et `production` (Settings → Environments) :
  - Pour `production` : cocher **Required reviewers** (gate d'approbation manuelle).
  - **Variables** de chaque environnement : coller la sortie
    `github_environment_variables` du root Terraform correspondant
    (`AWS_DEPLOY_ROLE_ARN`, `ECS_CLUSTER`, `ECS_*_SERVICE`, `ECS_*_TASKDEF`,
    `ECS_SUBNETS`, `ECS_SECURITY_GROUP`).

### Frontière Terraform ↔ pipeline

Terraform crée les services et les **premières** task definitions ; le pipeline
enregistre ensuite de **nouvelles révisions** (nouvelle image) et met à jour les
services. Les services ont donc `ignore_changes = [task_definition, desired_count]`
(l'autoscaling gère le compte) pour éviter que Terraform et le pipeline ne se
contredisent.

## Cloudflare

Zones des deux domaines **préparées sans bascule** : TLS strict, HTTPS forcé, WAF
managé de base. On n'ajoute que des enregistrements non conflictuels (SES, et
`api.<domaine>` proxifié) ; l'apex/www restent sur BigCommerce jusqu'à la tâche 25.

> Le provider est épinglé en **v4**. La v5 renomme des ressources
> (`cloudflare_record` → `cloudflare_dns_record`, changements sur `cloudflare_zone`) :
> migrer volontairement, pas par surprise. Le WAF managé requiert un plan **Pro+**.
> Si les zones existent déjà, les importer (`terraform import`).

## SES

Identités de domaine vérifiées par **Easy DKIM**, **MAIL FROM** aligné
(`mail.<domaine>`), **DMARC** en `p=none` (surveillance) au départ. La **sortie du
bac à sable** est une demande manuelle (console SES → _Account dashboard_ →
_Request production access_) — aucune ressource Terraform.

> SPF : on ne pose **pas** de SPF sur l'apex pour ne pas casser la messagerie
> existante. À la bascule (tâche 25), fusionner `include:amazonses.com` dans
> l'éventuel SPF apex existant.

## Sentry

Les 4 secrets DSN (`ffc/sentry/{api,web,admin,mobile}-dsn`) sont créés vides dans
Secrets Manager. Créer les projets dans Sentry, puis coller chaque DSN :

```bash
aws secretsmanager put-secret-value --secret-id ffc/sentry/api-dsn \
  --secret-string 'https://...ingest.sentry.io/...'
```

## Documentation opérationnelle

- [Coûts mensuels estimés](../docs/infra/couts.md)
- [Restauration de la base de données (snapshot + PITR)](../docs/infra/restauration-bd.md)
- [Rotation d'un secret](../docs/infra/rotation-secret.md)

## Notes

- **Isolation** : ce dépôt suppose **un seul compte AWS**, isolation par VPC/état
  distinct par environnement (adapté à « coûts maîtrisés »). Pour une isolation
  plus forte, séparer staging et production en **comptes distincts** (AWS
  Organizations) : dupliquer les backends et fournir un provider AWS par compte.
- **Pistes d'économie** : images **Graviton/ARM64** (Fargate ~20 % moins cher,
  build multi-arch requis), **Fargate Spot** pour les workers, **VPC endpoints**
  (S3/ECR/Secrets) pour réduire le trafic NAT.
