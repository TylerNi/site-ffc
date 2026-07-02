# RDS PostgreSQL : chiffré au repos (CMK), privé, SSL forcé, sauvegardes
# quotidiennes + PITR (backup_retention_period > 0), Multi-AZ en production.
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.data[*].id
  tags       = merge(local.tags, { Name = "${local.name}-db" })
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  tags = local.tags
}

resource "random_password" "db" {
  length  = 32
  special = false # évite les caractères à échapper dans l'URL de connexion
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  db_name  = "ffc"
  username = "ffc_admin"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = var.db_backup_retention
  backup_window              = "07:00-08:00" # UTC (~02h-03h heure de l'Est)
  maintenance_window         = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot      = true
  deletion_protection        = var.db_deletion_protection
  auto_minor_version_upgrade = true

  performance_insights_enabled          = var.db_multi_az
  performance_insights_kms_key_id       = var.db_multi_az ? aws_kms_key.main.arn : null
  performance_insights_retention_period = var.db_multi_az ? 7 : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  skip_final_snapshot       = !var.db_deletion_protection
  final_snapshot_identifier = var.db_deletion_protection ? "${local.name}-postgres-final" : null
  apply_immediately         = false

  tags = merge(local.tags, { Name = "${local.name}-postgres" })
}
