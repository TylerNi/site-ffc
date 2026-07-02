data "terraform_remote_state" "global" {
  backend = "s3"
  config = {
    bucket = var.tf_state_bucket
    key    = "global/terraform.tfstate"
    region = var.aws_region
  }
}

module "env" {
  source = "../../modules/environment"

  environment = "production"
  aws_region  = var.aws_region

  # Réseau : une passerelle NAT par AZ (haute disponibilité).
  vpc_cidr           = "10.10.0.0/16"
  single_nat_gateway = false

  # Base de données : Multi-AZ, protection contre la suppression, PITR 14 jours.
  db_instance_class        = "db.t4g.medium"
  db_allocated_storage     = 50
  db_max_allocated_storage = 200
  db_multi_az              = true
  db_backup_retention      = 14
  db_deletion_protection   = true

  # Redis : 2 nœuds, failover multi-AZ.
  redis_node_type          = "cache.t4g.small"
  redis_num_cache_clusters = 2
  redis_multi_az           = true

  # Conteneurs.
  ecr_repository_url = data.terraform_remote_state.global.outputs.ecr_repository_url
  cors_origins       = var.cors_origins

  api_cpu           = 512
  api_memory        = 1024
  api_desired_count = 2
  api_min_count     = 2
  api_max_count     = 6

  workers_cpu           = 512
  workers_memory        = 1024
  workers_desired_count = 2
  workers_min_count     = 1
  workers_max_count     = 4

  # DNS / TLS.
  api_domain         = var.api_domain
  cloudflare_zone_id = data.terraform_remote_state.global.outputs.cloudflare_zone_ids["fr"]

  # Secrets / observabilité.
  sentry_dsn_secret_arn = data.terraform_remote_state.global.outputs.sentry_dsn_secret_arns["api"]
  ses_identity_arns     = values(data.terraform_remote_state.global.outputs.ses_identity_arns)
  alert_email           = var.alert_email

  enable_uptime_canary     = true
  enable_queue_depth_alarm = false
}
