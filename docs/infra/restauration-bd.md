# Restauration de la base de données (snapshot + PITR)

RDS PostgreSQL est configuré avec des **sauvegardes automatiques quotidiennes**
et la **restauration à un instant précis (PITR)** : `backup_retention_period` =
**14 jours** en production, **7 jours** en staging. La PITR permet de restaurer à
la **seconde** près dans cette fenêtre.

> RDS **ne restaure jamais par-dessus** l'instance existante : on crée une
> **nouvelle** instance, on la vérifie, puis on bascule (renommage) au besoin.

## A. Restauration à un instant précis (PITR)

```bash
REGION=ca-central-1
SRC=ffc-production-postgres
TGT=ffc-production-postgres-pitr
WHEN=2026-07-02T14:30:00Z            # instant cible (UTC), dans la fenêtre

# Récupérer réseau/sécurité de la source pour rester privé
SUBNET_GROUP=$(aws rds describe-db-instances --db-instance-identifier "$SRC" \
  --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text --region $REGION)
SG=$(aws rds describe-db-instances --db-instance-identifier "$SRC" \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text --region $REGION)

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SRC" \
  --target-db-instance-identifier "$TGT" \
  --restore-time "$WHEN" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$SG" \
  --no-publicly-accessible \
  --region $REGION

aws rds wait db-instance-available --db-instance-identifier "$TGT" --region $REGION
```

## B. Restauration depuis un snapshot

```bash
aws rds describe-db-snapshots --db-instance-identifier "$SRC" \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotCreateTime]' \
  --output table --region $REGION

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$TGT" \
  --db-snapshot-identifier <snapshot-id> \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$SG" \
  --no-publicly-accessible --region $REGION
```

## C. Vérifier l'instance restaurée

Depuis une tâche ECS du même VPC (`aws ecs execute-command`) ou un bastion :

```bash
NEW_HOST=$(aws rds describe-db-instances --db-instance-identifier "$TGT" \
  --query 'DBInstances[0].Endpoint.Address' --output text --region $REGION)
psql "postgresql://ffc_admin:<mdp>@$NEW_HOST:5432/ffc?sslmode=require" \
  -c "SELECT now(); SELECT count(*) FROM information_schema.tables;"
```

Contrôler que les données attendues (dernière commande, dernier client) sont
présentes à l'instant `WHEN`.

## D. Basculer (si on remplace la production)

```bash
# Mettre l'API en maintenance (desired_count=0), renommer, puis remonter.
aws rds modify-db-instance --db-instance-identifier "$SRC" \
  --new-db-instance-identifier "${SRC}-old" --apply-immediately --region $REGION
aws rds modify-db-instance --db-instance-identifier "$TGT" \
  --new-db-instance-identifier "$SRC" --apply-immediately --region $REGION
```

Le secret `ffc/production/database-url` pointe sur l'**identifiant d'hôte** ; après
renommage l'endpoint est réattribué. Vérifier/mettre à jour le secret puis forcer
un redéploiement ECS (`aws ecs update-service --force-new-deployment`).

## E. Nettoyage

```bash
aws rds delete-db-instance --db-instance-identifier "${SRC}-old" \
  --skip-final-snapshot --region $REGION
```

## Journal du test PITR

> ⚠️ **À exécuter lors du premier vrai test** (nécessite l'infra provisionnée et
> des accès AWS). Ce runbook n'a **pas** pu être joué dans l'environnement de
> développement de la tâche 03 (ni compte AWS ni CLI). À remplir ensuite :

| Champ                    | Valeur      |
| ------------------------ | ----------- |
| Date du test             | _à remplir_ |
| Environnement            | staging     |
| Instant cible (WHEN)     | _à remplir_ |
| Durée de restauration    | _à remplir_ |
| Vérification des données | ✅ / ❌     |
| Opérateur                | _à remplir_ |

Recommandation : réaliser ce test **sur staging** une fois par trimestre.
