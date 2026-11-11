variable "project" {
  type        = string
  description = "Project name used in resource name prefixes and tags."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC. Must be a /16; subnet CIDRs are carved as /20 slices with cidrsubnet()."
  default     = "10.20.0.0/16"
}

variable "az_count" {
  type        = number
  description = "Number of AZs (and matching pairs of public/private subnets) to provision. Subnet CIDRs are derived with cidrsubnet(var.vpc_cidr, 4, i) for public[0..n) and cidrsubnet(var.vpc_cidr, 4, n+i) for private[0..n). With az_count=2 under 10.20.0.0/16 this reproduces the subnets Terraform state holds for staging today, so a plan is a no-op there."
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "app_port" {
  type        = number
  description = "Port that the application listens on behind the ALB."
  default     = 3000
}

variable "db_port" {
  type        = number
  description = "Port the database listens on (Postgres)."
  default     = 5432
}
