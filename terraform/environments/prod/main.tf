# ─── Production Environment ───────────────────────────────────────────────────
# This is the root module that wires everything together.
# Run: terraform init && terraform plan && terraform apply

terraform {
  required_version = ">= 1.6.0"

  backend "s3" {
    # Store Terraform state remotely — NEVER commit .tfstate to git
    bucket         = "booking-platform-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "booking-platform-tf-locks"  # prevents concurrent applies
  }

  required_providers {
    aws        = { source = "hashicorp/aws",  version = "~> 5.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.23" }
    helm       = { source = "hashicorp/helm", version = "~> 2.11" }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = local.project
      Environment = local.env
      ManagedBy   = "terraform"
    }
  }
}

locals {
  project = "booking-platform"
  env     = "prod"
}

# ─── Modules ─────────────────────────────────────────────────────────────────

module "vpc" {
  source      = "../../modules/vpc"
  project     = local.project
  environment = local.env
  vpc_cidr    = "10.0.0.0/16"
}

module "eks" {
  source              = "../../modules/eks"
  project             = local.project
  environment         = local.env
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  node_instance_type  = "m5.large"
  node_desired        = 3
  node_min            = 3
  node_max            = 10
  cluster_version     = "1.28"
}

module "rds" {
  source              = "../../modules/rds"
  project             = local.project
  environment         = local.env
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  db_password         = var.db_password  # from terraform.tfvars (gitignored) or AWS Secrets Manager
  instance_class      = "db.t3.medium"
}

module "msk" {
  source              = "../../modules/msk"
  project             = local.project
  environment         = local.env
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
}

module "ecr" {
  source      = "../../modules/ecr"
  project     = local.project
  environment = local.env
  services    = ["booking-service", "hotel-service", "inventory-service", "notification-service", "pms-dashboard"]
}

# ─── Helm Releases ────────────────────────────────────────────────────────────
# Deploy cluster-level tools via Helm after EKS is ready

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_ca_certificate)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_ca_certificate)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

# AWS Load Balancer Controller — manages ALBs from Ingress objects
resource "helm_release" "aws_lbc" {
  name       = "aws-load-balancer-controller"
  chart      = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  namespace  = "kube-system"
  version    = "1.6.2"

  set { name = "clusterName",     value = module.eks.cluster_name }
  set { name = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn", value = module.eks.oidc_provider_arn }
}

# Cluster Autoscaler — automatically scales node groups
resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  chart      = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  namespace  = "kube-system"
  version    = "9.29.3"

  set { name = "autoDiscovery.clusterName",   value = module.eks.cluster_name }
  set { name = "awsRegion",                   value = "us-east-1" }
  set { name = "extraArgs.balance-similar-node-groups", value = "true" }
  set { name = "extraArgs.skip-nodes-with-local-storage", value = "false" }
}

# Prometheus Stack (Prometheus + Grafana + AlertManager + node-exporter)
resource "helm_release" "kube_prometheus_stack" {
  name       = "kube-prometheus-stack"
  chart      = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  namespace  = "monitoring"
  version    = "55.5.0"
  create_namespace = true

  values = [file("${path.module}/helm-values/prometheus-stack.yaml")]
}

# Jaeger — distributed tracing
resource "helm_release" "jaeger" {
  name       = "jaeger"
  chart      = "jaeger"
  repository = "https://jaegertracing.github.io/helm-charts"
  namespace  = "monitoring"
  version    = "0.71.14"

  set { name = "provisionDataStore.cassandra", value = "false" }
  set { name = "allInOne.enabled",              value = "true" }  # for dev/staging; use production for prod
  set { name = "storage.type",                  value = "elasticsearch" }
}

# Fluent Bit — log collection from pods to CloudWatch/Elasticsearch
resource "helm_release" "fluent_bit" {
  name       = "fluent-bit"
  chart      = "fluent-bit"
  repository = "https://fluent.github.io/helm-charts"
  namespace  = "logging"
  version    = "0.39.0"
  create_namespace = true

  set { name = "config.outputs", value = "[OUTPUT]\n  Name cloudwatch_logs\n  Match *\n  region us-east-1\n  log_group_name /aws/eks/booking-platform/pods\n  log_stream_prefix pod-" }
}

# ─── Variables ────────────────────────────────────────────────────────────────
variable "db_password" {
  type      = string
  sensitive = true
}

# ─── Outputs ─────────────────────────────────────────────────────────────────
output "cluster_name"        { value = module.eks.cluster_name }
output "cluster_endpoint"    { value = module.eks.cluster_endpoint }
output "bookings_db_endpoint"{ value = module.rds.bookings_db_endpoint }
output "hotels_db_endpoint"  { value = module.rds.hotels_db_endpoint }
output "kafka_brokers"       { value = module.msk.bootstrap_brokers sensitive = true }
output "ecr_urls"            { value = module.ecr.repository_urls }
