variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type = string
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

variable "db_multi_az" {
  type        = bool
  description = "Enable multi-AZ for the primary RDS instance."
  default     = true
}
