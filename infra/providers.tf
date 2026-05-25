terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Backend config is passed at `terraform init` time (see .github/workflows/infra.yml).
  # State bucket region is independent of the workload region (var.aws_region).
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "fawtara"
      ManagedBy = "terraform"
    }
  }
}
