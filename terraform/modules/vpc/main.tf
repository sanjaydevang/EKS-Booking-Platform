# ─── VPC Module ───────────────────────────────────────────────────────────────
# Creates a production-grade VPC with:
#   - 3 public subnets  (ALB, NAT Gateways)
#   - 3 private subnets (EKS nodes, RDS, MSK)
#   - NAT Gateways (so private nodes can reach internet for ECR pulls)
#   - VPC Flow Logs (security/compliance)
#
# WHY 3 AZs? AWS EKS requires worker nodes in at least 2 AZs for HA.
# We use 3 for true resilience — one AZ can fail completely.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "project"     { type = string }
variable "environment" { type = string }
variable "vpc_cidr"    { type = string default = "10.0.0.0/16" }

locals {
  name = "${var.project}-${var.environment}"

  # Carve the VPC CIDR into /20 subnets for plenty of IPs
  # 10.0.0.0/20   = 4096 IPs — public-1a
  # 10.0.16.0/20  = 4096 IPs — public-1b
  # 10.0.32.0/20  = 4096 IPs — public-1c
  # 10.0.48.0/20  = 4096 IPs — private-1a (EKS nodes)
  # 10.0.64.0/20  = 4096 IPs — private-1b
  # 10.0.80.0/20  = 4096 IPs — private-1c
  public_subnets  = ["10.0.0.0/20",  "10.0.16.0/20", "10.0.32.0/20"]
  private_subnets = ["10.0.48.0/20", "10.0.64.0/20", "10.0.80.0/20"]
  azs             = ["us-east-1a",   "us-east-1b",   "us-east-1c"]
}

# ─── VPC ──────────────────────────────────────────────────────────────────────
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true  # required for EKS
  enable_dns_support   = true

  tags = {
    Name = "${local.name}-vpc"
    # These tags are REQUIRED for the AWS Load Balancer Controller to discover subnets
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
}

# ─── Internet Gateway ─────────────────────────────────────────────────────────
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-igw" }
}

# ─── Public Subnets ───────────────────────────────────────────────────────────
resource "aws_subnet" "public" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnets[count.index]
  availability_zone = local.azs[count.index]
  # Instances launched here get a public IP automatically
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-public-${local.azs[count.index]}"
    # ALB Controller looks for this tag to place public ALBs
    "kubernetes.io/role/elb" = "1"
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
}

# ─── Private Subnets ─────────────────────────────────────────────────────────
resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${local.name}-private-${local.azs[count.index]}"
    # ALB Controller uses this for internal ALBs
    "kubernetes.io/role/internal-elb" = "1"
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
}

# ─── NAT Gateways (one per AZ for HA) ────────────────────────────────────────
resource "aws_eip" "nat" {
  count  = 3
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-eip-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = 3
  subnet_id     = aws_subnet.public[count.index].id
  allocation_id = aws_eip.nat[count.index].id

  tags = { Name = "${local.name}-nat-${local.azs[count.index]}" }
  depends_on = [aws_internet_gateway.main]
}

# ─── Route Tables ─────────────────────────────────────────────────────────────
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private subnets route through NAT (different NAT per AZ for resilience)
resource "aws_route_table" "private" {
  count  = 3
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
  tags = { Name = "${local.name}-private-rt-${count.index}" }
}

resource "aws_route_table_association" "private" {
  count          = 3
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ─── VPC Flow Logs ────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  name              = "/aws/vpc/${local.name}/flow-logs"
  retention_in_days = 30
}

resource "aws_flow_log" "main" {
  vpc_id          = aws_vpc.main.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.flow_logs.arn
  log_destination = aws_cloudwatch_log_group.vpc_flow_logs.arn
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-vpc-flow-logs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  role   = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "*"
    }]
  })
}

# ─── Outputs ─────────────────────────────────────────────────────────────────
output "vpc_id"             { value = aws_vpc.main.id }
output "public_subnet_ids"  { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
