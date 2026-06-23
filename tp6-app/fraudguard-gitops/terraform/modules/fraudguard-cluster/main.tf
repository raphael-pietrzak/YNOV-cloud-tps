terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
    aws    = { source = "hashicorp/aws",    version = "~> 5.0" }
  }
}

variable "cloud_provider" {
  type = string
  validation {
    condition     = contains(["gcp", "aws"], var.cloud_provider)
    error_message = "cloud_provider doit être 'gcp' ou 'aws'."
  }
}

variable "cluster_name" {
  type    = string
  default = "fraudguard-cluster"
}

variable "region" {
  type        = string
  description = "europe-west9 pour GCP, eu-west-3 pour AWS"
}

# --- GCP / GKE ---
resource "google_container_cluster" "fraudguard" {
  count              = var.cloud_provider == "gcp" ? 1 : 0
  name               = var.cluster_name
  location           = var.region
  initial_node_count = 3
  node_config {
    machine_type = "e2-standard-4"
  }
}

# --- AWS / EKS ---
resource "aws_iam_role" "eks" {
  count = var.cloud_provider == "aws" ? 1 : 0
  name  = "${var.cluster_name}-eks-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster" {
  count      = var.cloud_provider == "aws" ? 1 : 0
  role       = aws_iam_role.eks[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_vpc" "eks" {
  count                = var.cloud_provider == "aws" ? 1 : 0
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "${var.cluster_name}-vpc" }
}

resource "aws_subnet" "eks" {
  count             = var.cloud_provider == "aws" ? 2 : 0
  vpc_id            = aws_vpc.eks[0].id
  cidr_block        = cidrsubnet(aws_vpc.eks[0].cidr_block, 8, count.index)
  availability_zone = "${var.region}${["a", "b"][count.index]}"
}

resource "aws_eks_cluster" "fraudguard" {
  count    = var.cloud_provider == "aws" ? 1 : 0
  name     = var.cluster_name
  role_arn = aws_iam_role.eks[0].arn
  vpc_config {
    subnet_ids = aws_subnet.eks[*].id
  }
  depends_on = [aws_iam_role_policy_attachment.eks_cluster]
}

output "cluster_endpoint" {
  value = var.cloud_provider == "gcp" ?
    google_container_cluster.fraudguard[0].endpoint :
    aws_eks_cluster.fraudguard[0].endpoint
}

output "cloud_provider" {
  value = var.cloud_provider
}
