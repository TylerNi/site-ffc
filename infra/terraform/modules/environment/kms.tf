# Clé gérée par le client (CMK) pour RDS, Redis, Secrets Manager et S3 privé.
# Rotation annuelle automatique. Les buckets d'images produits utilisent SSE-S3
# (contenu public via CDN) pour éviter d'accorder kms:Decrypt à CloudFront.
resource "aws_kms_key" "main" {
  description             = "CMK ${local.name} (RDS, Redis, Secrets, S3 privé)"
  deletion_window_in_days = 14
  enable_key_rotation     = true
  tags                    = merge(local.tags, { Name = "${local.name}-cmk" })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}
