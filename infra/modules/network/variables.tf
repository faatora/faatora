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
  description = "CIDR block for the VPC."
  default     = "10.20.0.0/16"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for the public subnets (one per AZ)."
  default     = ["10.20.0.0/20", "10.20.16.0/20"]
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for the private subnets (one per AZ)."
  default     = ["10.20.32.0/20", "10.20.48.0/20"]
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
