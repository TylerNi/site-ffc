variable "aws_region" {
  description = "Région AWS (résidence des données — Loi 25)."
  type        = string
  default     = "ca-central-1"
}

variable "github_owner" {
  description = "Propriétaire du dépôt GitHub (organisation ou utilisateur), pour la confiance OIDC."
  type        = string
}

variable "github_repo" {
  description = "Nom du dépôt GitHub."
  type        = string
  default     = "site-ffc"
}

variable "cloudflare_api_token" {
  description = "Jeton API Cloudflare (permissions Zone:Edit, DNS:Edit). Fourni via TF_VAR_*."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Identifiant du compte Cloudflare."
  type        = string
}

variable "domains" {
  description = "Domaines des deux vitrines, par locale."
  type        = map(string)
  default = {
    en = "furnacefilterscanada.com"
    fr = "filtrationmontreal.com"
  }
}

variable "dmarc_rua" {
  description = "Adresse de rapport agrégé DMARC (rua)."
  type        = string
  default     = "dmarc-reports@filtrationmontreal.com"
}
