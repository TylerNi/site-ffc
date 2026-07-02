# Secrets applicatifs (Secrets Manager, chiffrés CMK). DATABASE_URL et REDIS_URL
# sont dérivés de l'infra ; `app` regroupe les secrets applicatifs remplis hors
# dépôt (JWT, Stripe, etc.). Les tâches ECS les lisent au démarrage.
resource "aws_secretsmanager_secret" "database_url" {
  name        = "ffc/${var.environment}/database-url"
  description = "Chaîne de connexion PostgreSQL (${var.environment})"
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?schema=public&sslmode=require"
}

resource "aws_secretsmanager_secret" "redis_url" {
  name        = "ffc/${var.environment}/redis-url"
  description = "URL Redis (${var.environment})"
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:${aws_elasticache_replication_group.main.port}"
}

# Secrets applicatifs additionnels : valeur initiale placeholder, remplie hors
# dépôt par l'équipe (d'où ignore_changes).
resource "aws_secretsmanager_secret" "app" {
  name        = "ffc/${var.environment}/app"
  description = "Secrets applicatifs (JWT, Stripe, etc.) — ${var.environment}"
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ PLACEHOLDER = "a-renseigner" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

locals {
  # Secrets lisibles par le rôle d'exécution ECS.
  app_secret_arns = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.redis_url.arn,
    aws_secretsmanager_secret.app.arn,
    var.sentry_dsn_secret_arn,
  ]
}
