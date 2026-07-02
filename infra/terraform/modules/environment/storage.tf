# Trois buckets S3 par environnement. Accès public bloqué partout ; les images
# produits sont servies via CloudFront (OAC). ai-photos : suppression à 30 jours.
locals {
  buckets = {
    product_images = "${local.name}-product-images-${local.account_id}"
    ai_photos      = "${local.name}-ai-photos-${local.account_id}"
    invoices       = "${local.name}-invoices-${local.account_id}"
  }
}

resource "aws_s3_bucket" "b" {
  for_each = local.buckets
  bucket   = each.value
  tags     = merge(local.tags, { Name = each.value, Purpose = each.key })
}

resource "aws_s3_bucket_public_access_block" "b" {
  for_each                = aws_s3_bucket.b
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      # product-images : SSE-S3 (contenu public via CDN, évite d'accorder
      # kms:Decrypt à CloudFront). Autres buckets : SSE-KMS (données sensibles).
      sse_algorithm     = each.key == "product_images" ? "AES256" : "aws:kms"
      kms_master_key_id = each.key == "product_images" ? null : aws_kms_key.main.arn
    }
    bucket_key_enabled = each.key == "product_images" ? null : true
  }
}

resource "aws_s3_bucket_versioning" "invoices" {
  bucket = aws_s3_bucket.b["invoices"].id
  versioning_configuration {
    status = "Enabled"
  }
}

# ai-photos : cycle de vie — suppression 30 jours après dépôt.
resource "aws_s3_bucket_lifecycle_configuration" "ai_photos" {
  bucket = aws_s3_bucket.b["ai_photos"].id
  rule {
    id     = "expire-30j"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- CloudFront devant les images produits ---
resource "aws_cloudfront_origin_access_control" "images" {
  name                              = "${local.name}-images-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "images" {
  enabled     = true
  comment     = "${local.name} images produits"
  price_class = "PriceClass_100" # Amérique du Nord + Europe
  tags        = local.tags

  origin {
    domain_name              = aws_s3_bucket.b["product_images"].bucket_regional_domain_name
    origin_id                = "s3-product-images"
    origin_access_control_id = aws_cloudfront_origin_access_control.images.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-product-images"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Politique du bucket : lecture réservée à cette distribution CloudFront (OAC).
data "aws_iam_policy_document" "product_images" {
  statement {
    sid       = "AllowCloudFrontOAC"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.b["product_images"].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.images.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "product_images" {
  bucket = aws_s3_bucket.b["product_images"].id
  policy = data.aws_iam_policy_document.product_images.json
}
