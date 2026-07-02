# État distant chiffré + verrou. Le bucket S3 et la table DynamoDB doivent être
# provisionnés UNE fois avant le premier `terraform init` (voir infra/README.md,
# section « Amorçage de l'état »). Les valeurs ci-dessous sont des exemples :
# préférer `terraform init -backend-config=backend.hcl` pour ne rien coder en dur.
terraform {
  backend "s3" {
    bucket         = "REMPLACER-ffc-tfstate"
    key            = "global/terraform.tfstate"
    region         = "ca-central-1"
    dynamodb_table = "ffc-tfstate-locks"
    encrypt        = true
  }
}
