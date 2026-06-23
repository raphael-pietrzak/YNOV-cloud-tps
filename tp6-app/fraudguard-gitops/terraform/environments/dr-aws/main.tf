terraform {
  required_version = ">= 1.5"
  backend "s3" {
    bucket = "fraudguard-tfstate-dr"
    key    = "dr-aws/terraform.tfstate"
    region = "eu-west-3"
  }
}

provider "aws" {
  region = var.region
}

variable "cloud_provider" {
  type    = string
  default = "aws"
}

variable "region" {
  type    = string
  default = "eu-west-3"
}

module "fraudguard" {
  source         = "../../modules/fraudguard-cluster"
  cloud_provider = var.cloud_provider
  region         = var.region
  cluster_name   = "fraudguard-cluster-dr"
}

output "cluster_endpoint" {
  value = module.fraudguard.cluster_endpoint
}
