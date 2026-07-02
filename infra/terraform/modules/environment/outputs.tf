output "alb_dns_name" {
  description = "Nom DNS de l'ALB (origine du CNAME Cloudflare)."
  value       = aws_lb.main.dns_name
}

output "api_url" {
  description = "URL publique de l'API."
  value       = "https://${var.api_domain}"
}

output "cloudfront_domain" {
  description = "Domaine CloudFront des images produits."
  value       = aws_cloudfront_distribution.images.domain_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_api_service" {
  value = aws_ecs_service.api.name
}

output "ecs_workers_service" {
  value = aws_ecs_service.workers.name
}

output "ecs_api_taskdef" {
  value = aws_ecs_task_definition.api.family
}

output "ecs_workers_taskdef" {
  value = aws_ecs_task_definition.workers.family
}

output "ecs_migrate_taskdef" {
  value = aws_ecs_task_definition.migrate.family
}

output "ecs_subnets" {
  description = "Sous-réseaux app (CSV) pour la configuration réseau des tâches ponctuelles."
  value       = join(",", aws_subnet.app[*].id)
}

output "ecs_security_group" {
  value = aws_security_group.ecs_service.id
}

output "db_instance_identifier" {
  value = aws_db_instance.main.identifier
}

output "database_secret_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
