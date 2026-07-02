variable "aws_region" {
  type    = string
  default = "ca-central-1"
}

variable "tf_state_bucket" {
  description = "Bucket S3 de l'état Terraform (pour lire l'état du socle global)."
  type        = string
}

variable "cloudflare_api_token" {
  description = "Jeton API Cloudflare — fourni via TF_VAR_cloudflare_api_token."
  type        = string
  sensitive   = true
}

variable "alert_email" {
  description = "Adresse recevant les alarmes CloudWatch."
  type        = string
}

variable "api_domain" {
  type    = string
  default = "api.filtrationmontreal.com"
}

variable "cors_origins" {
  type    = string
  default = "https://filtrationmontreal.com,https://furnacefilterscanada.com"
}
