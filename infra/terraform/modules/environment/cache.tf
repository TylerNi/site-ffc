# ElastiCache Redis (files BullMQ) : chiffrement au repos (CMK) et en transit,
# jeton d'authentification. Failover automatique multi-AZ en production.
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis"
  subnet_ids = aws_subnet.data[*].id
  tags       = local.tags
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "Redis ${local.name} (files BullMQ)"
  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  port                 = 6379

  num_cache_clusters         = var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_multi_az
  multi_az_enabled           = var.redis_multi_az

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result

  snapshot_retention_limit = var.redis_multi_az ? 7 : 1
  maintenance_window       = "sun:09:30-sun:10:30"
  apply_immediately        = false

  tags = merge(local.tags, { Name = "${local.name}-redis" })
}
