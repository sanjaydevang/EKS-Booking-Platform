# ─── EKS Module ───────────────────────────────────────────────────────────────
# Creates an EKS cluster with:
#   - Managed node groups (AWS manages EC2, AMI updates, scaling)
#   - IRSA (IAM Roles for Service Accounts) — pods get IAM permissions without
#     needing static credentials
#   - OIDC provider — enables IRSA
#   - aws-auth ConfigMap managed by Terraform
#
# COST: A 3-node m5.large cluster ≈ $200/month.
# For learning: use 2x t3.medium (cheaper). For production: m5.large minimum.

variable "project"            { type = string }
variable "environment"        { type = string }
variable "cluster_version"    { type = string default = "1.28" }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "node_instance_type" { type = string default = "m5.large" }
variable "node_desired"       { type = number default = 3 }
variable "node_min"           { type = number default = 2 }
variable "node_max"           { type = number default = 10 }

locals {
  cluster_name = "${var.project}-${var.environment}"
}

# ─── EKS Cluster IAM Role ─────────────────────────────────────────────────────
resource "aws_iam_role" "cluster" {
  name = "${local.cluster_name}-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.cluster.name
}

# ─── EKS Cluster ──────────────────────────────────────────────────────────────
resource "aws_eks_cluster" "main" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.cluster_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_public_access  = true   # kubectl from developer laptops
    endpoint_private_access = true   # Jenkins pods inside VPC
    public_access_cidrs     = ["0.0.0.0/0"]  # lock down in prod: only office IPs
  }

  # Enable control plane logging to CloudWatch
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [aws_iam_role_policy_attachment.cluster_policy]

  tags = {
    Name        = local.cluster_name
    Environment = var.environment
  }
}

# ─── OIDC Provider (required for IRSA) ───────────────────────────────────────
# IRSA = IAM Roles for Service Accounts
# Each pod's ServiceAccount is mapped to an IAM Role.
# The pod can then call AWS APIs (S3, SES, Secrets Manager) without storing keys.
data "tls_certificate" "cluster" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

# ─── Node Group IAM Role ──────────────────────────────────────────────────────
resource "aws_iam_role" "nodes" {
  name = "${local.cluster_name}-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "nodes" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"  # for EC2 Instance Connect (no bastion needed)
  ])
  policy_arn = each.value
  role       = aws_iam_role.nodes.name
}

# ─── EKS Managed Node Group ───────────────────────────────────────────────────
# AWS manages: EC2 instances, AMIs, OS patching, K8s node registration
# You only specify: instance type, size, and which subnets
resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.cluster_name}-workers"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = var.private_subnet_ids  # nodes are PRIVATE (no public IP)

  instance_types = [var.node_instance_type]

  # Disk size for container images and logs
  disk_size = 50

  scaling_config {
    desired_size = var.node_desired
    min_size     = var.node_min
    max_size     = var.node_max
  }

  # Rolling update: replace one node at a time
  update_config {
    max_unavailable = 1
  }

  # Node labels — used for pod scheduling (nodeSelector / affinity)
  labels = {
    role        = "worker"
    environment = var.environment
  }

  tags = {
    # Cluster Autoscaler looks for these tags to know which node groups to scale
    "k8s.io/cluster-autoscaler/enabled"                  = "true"
    "k8s.io/cluster-autoscaler/${local.cluster_name}"    = "owned"
  }

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]  # let Cluster Autoscaler manage this
  }
}

# ─── EKS Add-ons ─────────────────────────────────────────────────────────────
# Managed add-ons: AWS keeps these updated and patched
resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "coredns"
  addon_version               = "v1.10.1-eksbuild.4"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "kube-proxy"
  addon_version = "v1.28.2-eksbuild.2"
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name  = aws_eks_cluster.main.name
  addon_name    = "vpc-cni"
  addon_version = "v1.15.4-eksbuild.1"
  # IRSA for VPC CNI to manage ENIs
  service_account_role_arn = aws_iam_role.vpc_cni_irsa.arn
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "aws-ebs-csi-driver"
  addon_version            = "v1.25.0-eksbuild.1"
  service_account_role_arn = aws_iam_role.ebs_csi_irsa.arn
}

# ─── IRSA: VPC CNI ───────────────────────────────────────────────────────────
resource "aws_iam_role" "vpc_cni_irsa" {
  name = "${local.cluster_name}-vpc-cni-irsa"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.cluster.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:sub" = "system:serviceaccount:kube-system:aws-node"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "vpc_cni_irsa" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.vpc_cni_irsa.name
}

# ─── IRSA: EBS CSI Driver ────────────────────────────────────────────────────
resource "aws_iam_role" "ebs_csi_irsa" {
  name = "${local.cluster_name}-ebs-csi-irsa"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.cluster.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ebs_csi_irsa" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  role       = aws_iam_role.ebs_csi_irsa.name
}

# ─── Outputs ─────────────────────────────────────────────────────────────────
output "cluster_name"            { value = aws_eks_cluster.main.name }
output "cluster_endpoint"        { value = aws_eks_cluster.main.endpoint }
output "cluster_ca_certificate"  { value = aws_eks_cluster.main.certificate_authority[0].data }
output "oidc_provider_arn"       { value = aws_iam_openid_connect_provider.cluster.arn }
output "oidc_provider_url"       { value = aws_iam_openid_connect_provider.cluster.url }
