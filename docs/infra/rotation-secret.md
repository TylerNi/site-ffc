# Rotation d'un secret

Tous les secrets vivent dans **AWS Secrets Manager** (chiffrés CMK). Les tâches
ECS lisent leurs secrets **au démarrage** : après une rotation, il faut forcer un
**nouveau déploiement** pour que les tâches relisent la valeur.

## A. Secret applicatif simple (JWT, clé Stripe, DSN Sentry…)

```bash
REGION=ca-central-1
aws secretsmanager put-secret-value \
  --secret-id ffc/production/app \
  --secret-string "$(cat nouvelle-valeur.json)" --region $REGION

# Les tâches relisent au démarrage -> forcer un redéploiement
aws ecs update-service --cluster ffc-production \
  --service ffc-production-api --force-new-deployment --region $REGION
aws ecs update-service --cluster ffc-production \
  --service ffc-production-workers --force-new-deployment --region $REGION
```

## B. Mot de passe maître PostgreSQL (`ffc/<env>/database-url`)

Ordre important pour éviter toute coupure : **changer le mot de passe RDS, puis le
secret, puis redéployer.**

```bash
REGION=ca-central-1
ENV=production
DB=ffc-${ENV}-postgres

# 1) Nouveau mot de passe fort
NEWPW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)

# 2) Appliquer à RDS
aws rds modify-db-instance --db-instance-identifier "$DB" \
  --master-user-password "$NEWPW" --apply-immediately --region $REGION
aws rds wait db-instance-available --db-instance-identifier "$DB" --region $REGION

# 3) Reconstruire l'URL et mettre à jour le secret
HOST=$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].Endpoint.Address' --output text --region $REGION)
aws secretsmanager put-secret-value --secret-id ffc/${ENV}/database-url \
  --secret-string "postgresql://ffc_admin:${NEWPW}@${HOST}:5432/ffc?schema=public&sslmode=require" \
  --region $REGION

# 4) Redéployer pour relire le secret
aws ecs update-service --cluster ffc-${ENV} --service ffc-${ENV}-api --force-new-deployment --region $REGION
aws ecs update-service --cluster ffc-${ENV} --service ffc-${ENV}-workers --force-new-deployment --region $REGION
```

> ⚠️ Le mot de passe est aussi géré par Terraform (`random_password.db`). Cette
> rotation manuelle crée un écart d'état volontaire ; au prochain `terraform apply`,
> soit on réaligne le secret sur la valeur Terraform, soit on met
> `ignore_changes = [password]` sur `aws_db_instance.main` avant la rotation. Le
> plus propre à terme : activer la **rotation automatique Secrets Manager**
> (Lambda de rotation RDS), planifiée dans une tâche de durcissement (tâche 26).

## C. Jeton Cloudflare / clés tierces

Régénérer côté fournisseur, mettre à jour le secret correspondant (ou la variable
`TF_VAR_*` pour Cloudflare), puis rejouer le `terraform apply` concerné.

## Bonnes pratiques

- Ne jamais écrire un secret en clair dans le dépôt, un log ou un ticket.
- Après rotation, **vérifier** `/v1/health` et les journaux applicatifs.
- Tracer chaque rotation (qui, quand, pourquoi) — pertinent pour la Loi 25.
