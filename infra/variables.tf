variable "aws_region" {
  type        = string
  description = "AWS region the stack is deployed to. No default on purpose: the caller must pass it (via -var-file=environments/<env>.tfvars) so a run can never land in the wrong region by accident."
}

variable "environment" {
  type        = string
  description = "Deployment environment (staging, production). Used as the second half of every name prefix and to drive per-env tfvars selection."
}

variable "project" {
  type    = string
  default = "faatora"
}

variable "enable_infra" {
  type    = bool
  default = false
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC created by the network module."
  default     = "10.20.0.0/16"
}

variable "az_count" {
  type        = number
  description = "Number of AZs (and matching pairs of public/private subnets) to provision. Staging runs 2; production runs 3 to meet PDPL/GDPR resiliency expectations."
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4 (we only carve /20 subnet pairs out of a /16 for up to 4 AZs)."
  }
}

variable "db_multi_az" {
  type        = bool
  description = "Enable multi-AZ for the primary RDS instance."
  default     = true
}
