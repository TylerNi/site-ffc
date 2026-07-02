data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  common_tags = {
    Project       = "ffc"
    Scope         = "global"
    ManagedBy     = "terraform"
    DataResidency = "ca-central-1"
  }
}
