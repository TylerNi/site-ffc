output "ecr_repository_url" {
  description = "URL du dépôt ECR de l'API."
  value       = aws_ecr_repository.api.repository_url
}

output "github_build_role_arn" {
  description = "Rôle assumé par le workflow de build pour pousser sur ECR."
  value       = aws_iam_role.github_build.arn
}

output "github_deploy_role_arns" {
  description = "Rôles de déploiement par environnement (à mettre dans les variables d'environnement GitHub)."
  value       = { for k, r in aws_iam_role.github_deploy : k => r.arn }
}

output "cloudflare_zone_ids" {
  description = "Identifiants de zone Cloudflare par locale."
  value       = { for k, z in cloudflare_zone.zone : k => z.id }
}

output "ses_configuration_set" {
  description = "Nom du configuration set SES."
  value       = aws_sesv2_configuration_set.main.configuration_set_name
}

output "ses_identity_arns" {
  description = "ARNs des identités SES (pour restreindre ses:SendEmail côté task role)."
  value       = { for k, id in aws_sesv2_email_identity.domain : k => id.arn }
}

output "sentry_dsn_secret_arns" {
  description = "ARNs des secrets DSN Sentry par application."
  value       = { for k, s in aws_secretsmanager_secret.sentry_dsn : k => s.arn }
}
