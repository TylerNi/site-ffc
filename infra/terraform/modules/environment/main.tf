data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name       = "ffc-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, var.azs_count)

  tags = merge({
    Project       = "ffc"
    Environment   = var.environment
    ManagedBy     = "terraform"
    DataResidency = var.aws_region
  }, var.tags)
}
