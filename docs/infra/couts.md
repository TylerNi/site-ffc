# Coûts mensuels estimés

Estimations **approximatives**, région `ca-central-1`, en USD, **hors taxes** et
**hors trafic variable** (transfert de données, requêtes CloudFront/S3). Base
« au repos » (avant montée en charge de l'autoscaling). À valider avec le
[calculateur AWS](https://calculator.aws/) une fois les volumes réels connus.

## Staging (modeste, mono-AZ)

| Poste                         | Détail                                     | ~ USD/mois |
| ----------------------------- | ------------------------------------------ | ---------: |
| ECS Fargate                   | api 0,25 vCPU/0,5 Gio + workers idem, 24/7 |         20 |
| RDS PostgreSQL                | `db.t4g.micro` mono-AZ + 20 Gio gp3        |         15 |
| ElastiCache Redis             | `cache.t4g.micro`, 1 nœud                  |         12 |
| ALB                           | 1 équilibreur + LCU faibles                |         18 |
| NAT Gateway                   | **1 seule** passerelle                     |         33 |
| S3 + CloudFront               | faible volume                              |          4 |
| Secrets Manager               | ~4 secrets × 0,40 $                        |          2 |
| CloudWatch + sonde Synthetics | logs + alarmes + canary (5 min)            |         15 |
| KMS                           | 1 CMK                                      |          1 |
| **Total**                     |                                            |   **~120** |

## Production (HA, Multi-AZ)

| Poste                         | Détail                                           | ~ USD/mois |
| ----------------------------- | ------------------------------------------------ | ---------: |
| ECS Fargate                   | api 0,5 vCPU/1 Gio ×2 + workers ×2, 24/7         |         80 |
| RDS PostgreSQL                | `db.t4g.medium` **Multi-AZ** + 50 Gio gp3 + PITR |        115 |
| ElastiCache Redis             | `cache.t4g.small` ×2 nœuds, failover             |         45 |
| ALB                           | 1 équilibreur + LCU                              |         20 |
| NAT Gateway                   | **1 par AZ** (2)                                 |         66 |
| S3 + CloudFront               | volume modéré                                    |          8 |
| Secrets Manager               | ~4 secrets                                       |          2 |
| CloudWatch + sonde Synthetics | logs + alarmes + canary                          |         20 |
| KMS                           | 1 CMK                                            |          1 |
| **Total**                     |                                                  |   **~355** |

Le socle **global** (ECR, OIDC, zones Cloudflare, SES, secrets) est négligeable
(< 5 $/mois : essentiellement le stockage ECR).

## Principaux leviers de coût

1. **RDS Multi-AZ** (double l'instance) — le poste le plus lourd en prod.
2. **NAT Gateway** — coût horaire **+ traitement des données**. Des **VPC
   endpoints** (S3, ECR, Secrets Manager, CloudWatch Logs) réduisent fortement le
   trafic NAT sortant.
3. **Fargate** — passer les images en **Graviton/ARM64** (~20 % d'économie) et les
   **workers en Fargate Spot**.
4. **Sonde Synthetics** — ~0,0012 $/exécution ; à 5 min c'est ~10 $/mois. Espacer
   à 10-15 min si besoin.

> Ordre de grandeur cible : **~120 $/mois staging + ~355 $/mois production**,
> à affiner avec le trafic réel.
