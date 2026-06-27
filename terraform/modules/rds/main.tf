# ─── RDS Module ───────────────────────────────────────────────────────────────
# Creates PostgreSQL RDS instances for booking-service and hotel-service.
# Uses Multi-AZ for HA: primary in us-east-1a, standby in us-east-1b.
# Automatic failover < 60 seconds if primary fails.

variable "project"            { type = string }
variable "environment"        { type = string }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "db_password"        { type = string sensitive = true }
variable "instance_class"     { type = string default = "db.t3.medium" }
variable "allocated_storage"  { type = number default = 50 }

locals {
  name = "${var.project}-${var.environment}"
}

# ─── Subnet Group (which subnets RDS can use) ────────────────────────────────
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnet-group"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${local.name}-db-subnet-group" }
}

# ─── Security Group ───────────────────────────────────────────────────────────
resource "aws_security_group" "rds" {
  name   = "${local.name}-rds-sg"
  vpc_id = var.vpc_id

  # Only allow connections from EKS nodes (not from the internet)
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.48.0/20", "10.0.64.0/20", "10.0.80.0/20"]  # private subnets
  }

  tags = { Name = "${local.name}-rds-sg" }
}

# ─── Parameter Group (PostgreSQL tuning) ─────────────────────────────────────
resource "aws_db_parameter_group" "main" {
  family = "postgres15"
  name   = "${local.name}-pg15-params"

  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_statement"
    value = "ddl"    # log CREATE/ALTER/DROP but not every SELECT
  }
  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"   # enables query performance monitoring
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"   # log queries taking > 1 second
  }
}

# ─── Bookings DB ──────────────────────────────────────────────────────────────
resource "aws_db_instance" "bookings" {
  identifier = "${local.name}-bookings-db"

  engine         = "postgres"
  engine_version = "15.4"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = 200  # autoscaling: grows up to 200 GB
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "bookings_db"
  username = "booking_admin"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az               = var.environment == "prod" ? true : false
  publicly_accessible    = false  # NEVER public
  deletion_protection    = var.environment == "prod" ? true : false

  backup_retention_period = 7    # 7 days of automated backups
  backup_window           = "03:00-04:00"    # UTC, during low traffic
  maintenance_window      = "Mon:04:00-Mon:05:00"

  # Performance Insights: slow query analysis in AWS Console
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Enhanced monitoring: per-second metrics (OS level)
  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = "${local.name}-bookings-final-snapshot"

  tags = { Name = "${local.name}-bookings-db", Service = "booking-service" }
}

# ─── Hotels DB ────────────────────────────────────────────────────────────────
resource "aws_db_instance" "hotels" {
  identifier     = "${local.name}-hotels-db"
  engine         = "postgres"
  engine_version = "15.4"
  instance_class = var.instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "hotels_db"
  username = "hotel_admin"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az            = var.environment == "prod" ? true : false
  publicly_accessible = false
  deletion_protection = var.environment == "prod" ? true : false

  backup_retention_period = 7
  skip_final_snapshot     = var.environment != "prod"

  tags = { Name = "${local.name}-hotels-db", Service = "hotel-service" }
}

# ─── RDS Enhanced Monitoring Role ────────────────────────────────────────────
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
  role       = aws_iam_role.rds_monitoring.name
}

output "bookings_db_endpoint" { value = aws_db_instance.bookings.endpoint }
output "hotels_db_endpoint"   { value = aws_db_instance.hotels.endpoint }
