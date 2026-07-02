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

  environment = "staging"
  aws_region  = var.aws_region

  # Réseau : une seule passerelle NAT (économie).
  vpc_cidr           = "10.20.0.0/16"
  single_nat_gateway = true

  # Base de données : instance modeste, mono-AZ.
  db_instance_class      = "db.t4g.micro"
  db_allocated_storage   = 20
  db_multi_az            = false
  db_backup_retention    = 7
  db_deletion_protection = false

  # Redis : un seul nœud.
  redis_node_type          = "cache.t4g.micro"
  redis_num_cache_clusters = 1
  redis_multi_az           = false

  # Conteneurs.
  ecr_repository_url = data.terraform_remote_state.global.outputs.ecr_repository_url
  cors_origins       = var.cors_origins

  api_cpu           = 256
  api_memory        = 512
  api_desired_count = 1
  api_min_count     = 1
  api_max_count     = 3

  workers_cpu           = 256
  workers_memory        = 512
  workers_desired_count = 1
  workers_min_count     = 1
  workers_max_count     = 2

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
