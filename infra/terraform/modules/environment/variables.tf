variable "environment" {
  description = "Nom de l'environnement (staging | production)."
  type        = string
}

variable "aws_region" {
  description = "Région AWS."
  type        = string
  default     = "ca-central-1"
}

variable "tags" {
  description = "Étiquettes additionnelles."
  type        = map(string)
  default     = {}
}

# --- Réseau ---
variable "vpc_cidr" {
  description = "Bloc CIDR du VPC (/16)."
  type        = string
}

variable "azs_count" {
  description = "Nombre de zones de disponibilité."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "Une seule passerelle NAT (staging, économie) ou une par AZ (prod, HA)."
  type        = bool
  default     = true
}

# --- Base de données (RDS PostgreSQL) ---
variable "db_engine_version" {
  type    = string
  default = "16.4"
}
variable "db_instance_class" {
  type = string
}
variable "db_allocated_storage" {
  type    = number
  default = 20
}
variable "db_max_allocated_storage" {
  type    = number
  default = 100
}
variable "db_multi_az" {
  type    = bool
  default = false
}
variable "db_backup_retention" {
  description = "Rétention des sauvegardes en jours (active la PITR si > 0)."
  type        = number
  default     = 7
}
variable "db_deletion_protection" {
  type    = bool
  default = false
}

# --- Cache (ElastiCache Redis) ---
variable "redis_engine_version" {
  type    = string
  default = "7.1"
}
variable "redis_node_type" {
  type = string
}
variable "redis_num_cache_clusters" {
  description = "Nombre de nœuds (>= 2 pour le failover)."
  type        = number
  default     = 1
}
variable "redis_multi_az" {
  type    = bool
  default = false
}

# --- Conteneurs / ECS ---
variable "ecr_repository_url" {
  description = "URL du dépôt ECR (sortie du socle global)."
  type        = string
}
variable "container_image_tag" {
  description = "Tag de l'image à déployer initialement (le pipeline gère ensuite les révisions)."
  type        = string
  default     = "latest"
}
variable "cors_origins" {
  description = "Origines CORS autorisées par l'API (séparées par des virgules)."
  type        = string
}

variable "api_cpu" {
  type    = number
  default = 256
}
variable "api_memory" {
  type    = number
  default = 512
}
variable "api_desired_count" {
  type    = number
  default = 1
}
variable "api_min_count" {
  type    = number
  default = 1
}
variable "api_max_count" {
  type    = number
  default = 4
}

variable "workers_cpu" {
  type    = number
  default = 256
}
variable "workers_memory" {
  type    = number
  default = 512
}
variable "workers_desired_count" {
  type    = number
  default = 1
}
variable "workers_min_count" {
  type    = number
  default = 1
}
variable "workers_max_count" {
  type    = number
  default = 3
}

# --- DNS / TLS ---
variable "api_domain" {
  description = "Nom d'hôte public de l'API (ex. api.staging.filtrationmontreal.com)."
  type        = string
}
variable "cloudflare_zone_id" {
  description = "Zone Cloudflare hébergeant le sous-domaine de l'API."
  type        = string
}

# --- Secrets / observabilité ---
variable "sentry_dsn_secret_arn" {
  description = "ARN du secret contenant le DSN Sentry de l'API (socle global)."
  type        = string
}
variable "ses_identity_arns" {
  description = "ARNs des identités SES autorisées à l'envoi (socle global)."
  type        = list(string)
}
variable "alert_email" {
  description = "Adresse recevant les alarmes CloudWatch (via SNS)."
  type        = string
}
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "enable_uptime_canary" {
  description = "Créer une sonde Synthetics sur /v1/health."
  type        = bool
  default     = true
}
variable "enable_queue_depth_alarm" {
  description = "Alarme sur la profondeur des files (métrique custom publiée par les workers — tâche 14+)."
  type        = bool
  default     = false
}
