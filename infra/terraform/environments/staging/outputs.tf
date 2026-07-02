output "api_url" {
  value = module.env.api_url
}

output "alb_dns_name" {
  value = module.env.alb_dns_name
}

output "cloudfront_domain" {
  value = module.env.cloudfront_domain
}

# À reporter tel quel dans les VARIABLES de l'environnement GitHub `staging`
# (`terraform output -json github_environment_variables`).
output "github_environment_variables" {
  description = "Variables à définir dans l'environnement GitHub staging."
  value = {
    AWS_DEPLOY_ROLE_ARN = data.terraform_remote_state.global.outputs.github_deploy_role_arns["staging"]
    ECS_CLUSTER         = module.env.ecs_cluster_name
    ECS_API_SERVICE     = module.env.ecs_api_service
    ECS_WORKERS_SERVICE = module.env.ecs_workers_service
    ECS_API_TASKDEF     = module.env.ecs_api_taskdef
    ECS_WORKERS_TASKDEF = module.env.ecs_workers_taskdef
    ECS_MIGRATE_TASKDEF = module.env.ecs_migrate_taskdef
    ECS_SUBNETS         = module.env.ecs_subnets
    ECS_SECURITY_GROUP  = module.env.ecs_security_group
  }
}
