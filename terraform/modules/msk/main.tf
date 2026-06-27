# ─── MSK (Managed Streaming for Kafka) Module ────────────────────────────────
# AWS MSK handles broker provisioning, ZooKeeper, OS patching, auto-recovery.
# Our services connect to MSK brokers via VPC (no internet exposure).
#
# TOPICS:
#   booking-events  — published by booking-service, consumed by notification-service + inventory-service
#   hotel-events    — published by hotel-service, consumed by booking-service
#   booking-events-dlq — dead letter queue for failed message processing
#   hotel-events-dlq

variable "project"            { type = string }
variable "environment"        { type = string }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }

locals {
  name = "${var.project}-${var.environment}"
}

# ─── Security Group ───────────────────────────────────────────────────────────
resource "aws_security_group" "msk" {
  name   = "${local.name}-msk-sg"
  vpc_id = var.vpc_id

  ingress {
    description = "Kafka plaintext from EKS nodes"
    from_port   = 9092
    to_port     = 9092
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  ingress {
    description = "Kafka TLS from EKS nodes"
    from_port   = 9094
    to_port     = 9094
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  tags = { Name = "${local.name}-msk-sg" }
}

# ─── MSK Cluster ─────────────────────────────────────────────────────────────
resource "aws_msk_cluster" "main" {
  cluster_name           = "${local.name}-kafka"
  kafka_version          = "3.5.1"
  number_of_broker_nodes = 3  # one per AZ

  broker_node_group_info {
    instance_type  = "kafka.m5.large"
    client_subnets = var.private_subnet_ids
    storage_info {
      ebs_storage_info {
        volume_size = 100  # GB per broker
      }
    }
    security_groups = [aws_security_group.msk.id]
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS_PLAINTEXT"  # support both for dev convenience
      in_cluster    = true
    }
  }

  # CloudWatch metrics for Kafka — visible in Grafana via CloudWatch data source
  open_monitoring {
    prometheus {
      jmx_exporter  { enabled_in_broker = true }
      node_exporter { enabled_in_broker = true }
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  tags = { Name = "${local.name}-kafka" }
}

# ─── MSK Configuration ────────────────────────────────────────────────────────
resource "aws_msk_configuration" "main" {
  name              = "${local.name}-kafka-config"
  kafka_versions    = ["3.5.1"]
  server_properties = <<-EOF
    # Retention: keep messages for 7 days (consumers can replay)
    log.retention.hours=168

    # Replication factor: each message stored on 3 brokers
    default.replication.factor=3

    # Minimum in-sync replicas: at least 2 must confirm write
    min.insync.replicas=2

    # Auto-create topics: disabled (we create explicitly)
    auto.create.topics.enable=false

    # Compression
    compression.type=lz4
  EOF
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/aws/msk/${local.name}"
  retention_in_days = 14
}

output "bootstrap_brokers"     { value = aws_msk_cluster.main.bootstrap_brokers }
output "bootstrap_brokers_tls" { value = aws_msk_cluster.main.bootstrap_brokers_tls }
