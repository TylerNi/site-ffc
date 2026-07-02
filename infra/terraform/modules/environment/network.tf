# VPC à trois tiers de sous-réseaux par AZ : public (ALB, NAT), privé-app (ECS),
# privé-data (RDS, Redis — sans route vers Internet). Groupes de sécurité au
# moindre privilège, références SG-à-SG (aucun 0.0.0.0/0 sauf ingress ALB
# restreint aux plages Cloudflare, et egress).

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.azs_count
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-public-${count.index}", Tier = "public" })
}

resource "aws_subnet" "app" {
  count             = var.azs_count
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 4)
  tags              = merge(local.tags, { Name = "${local.name}-app-${count.index}", Tier = "private-app" })
}

resource "aws_subnet" "data" {
  count             = var.azs_count
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  tags              = merge(local.tags, { Name = "${local.name}-data-${count.index}", Tier = "private-data" })
}

# --- NAT : une seule passerelle en staging, une par AZ en production. ---
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : var.azs_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "main" {
  count         = var.single_nat_gateway ? 1 : var.azs_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${local.name}-nat-${count.index}" })
  depends_on    = [aws_internet_gateway.main]
}

# --- Tables de routage ---
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = merge(local.tags, { Name = "${local.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = var.azs_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = var.azs_count
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
  }
  tags = merge(local.tags, { Name = "${local.name}-private-${count.index}" })
}

resource "aws_route_table_association" "app" {
  count          = var.azs_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Tier data : table de routage sans route Internet (isolation totale).
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${local.name}-data" })
}

resource "aws_route_table_association" "data" {
  count          = var.azs_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# --- Groupes de sécurité ---

# Origine verrouillée : l'ALB n'accepte le trafic que des plages Cloudflare.
data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB public — HTTPS depuis Cloudflare uniquement"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(data.cloudflare_ip_ranges.cloudflare.ipv4_cidr_blocks)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS depuis Cloudflare"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(data.cloudflare_ip_ranges.cloudflare.ipv4_cidr_blocks)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirigé vers HTTPS) depuis Cloudflare"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "Sortie vers les tâches ECS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "ecs_service" {
  name        = "${local.name}-ecs"
  description = "Tâches ECS — ingress depuis l'ALB uniquement"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-ecs" })
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs_service.id
  description                  = "Port conteneur depuis l'ALB"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 4000
  to_port                      = 4000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "ecs_all" {
  security_group_id = aws_security_group.ecs_service.id
  description       = "Sortie (AWS APIs, SES, Secrets, RDS, Redis via NAT/local)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "PostgreSQL — depuis les tâches ECS uniquement"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-rds" })
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_ecs" {
  security_group_id            = aws_security_group.rds.id
  description                  = "5432 depuis ECS"
  referenced_security_group_id = aws_security_group.ecs_service.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis — depuis les tâches ECS uniquement"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${local.name}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs" {
  security_group_id            = aws_security_group.redis.id
  description                  = "6379 depuis ECS"
  referenced_security_group_id = aws_security_group.ecs_service.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
