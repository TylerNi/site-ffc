provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project       = "ffc"
      Scope         = "global"
      ManagedBy     = "terraform"
      DataResidency = "ca-central-1"
    }
  }
}

# Jeton fourni hors dépôt : export TF_VAR_cloudflare_api_token=...
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
