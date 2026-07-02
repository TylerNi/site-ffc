# Secrets Sentry : un DSN par application (api/web/admin/mobile), stockés dans
# Secrets Manager. Les valeurs réelles sont collées HORS dépôt (console Sentry ->
# projet -> Client Keys), d'où `ignore_changes`. La création des projets Sentry
# est un geste manuel documenté (infra/README.md) — on évite ici un provider
# Sentry qui exigerait un jeton d'organisation.
locals {
  sentry_apps = toset(["api", "web", "admin", "mobile"])
}

resource "aws_secretsmanager_secret" "sentry_dsn" {
  for_each    = local.sentry_apps
  name        = "ffc/sentry/${each.key}-dsn"
  description = "DSN Sentry — application ${each.key} (à renseigner hors dépôt)."
}

resource "aws_secretsmanager_secret_version" "sentry_dsn" {
  for_each      = aws_secretsmanager_secret.sentry_dsn
  secret_id     = each.value.id
  secret_string = "REMPLACER"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
