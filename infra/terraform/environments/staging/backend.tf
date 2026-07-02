# Voir infra/README.md (« Amorçage de l'état »). Préférer
# `terraform init -backend-config=backend.hcl`.
terraform {
  backend "s3" {
    bucket         = "REMPLACER-ffc-tfstate"
    key            = "staging/terraform.tfstate"
    region         = "ca-central-1"
    dynamodb_table = "ffc-tfstate-locks"
    encrypt        = true
  }
}
