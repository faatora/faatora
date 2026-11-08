variable "project" {
  type        = string
  description = "Project name used in resource name prefixes."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "vpc_subnet_ids" {
  type        = list(string)
  description = "Private subnet ids for the DB subnet group."
}

variable "db_sg_id" {
  type        = string
  description = "Security group id attached to the DB instance."
}

variable "db_name" {
  type        = string
  description = "Initial database name."
  default     = "fawtara"
}

variable "master_username" {
  type        = string
  description = "Master username for the DB."
  default     = "fawtara_admin"
}

variable "instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
}

variable "engine_version" {
  type        = string
  description = "Postgres engine version."
  default     = "16.4"
}

variable "allocated_storage" {
  type        = number
  description = "Initial allocated storage in GB."
  default     = 20
}

variable "max_allocated_storage" {
  type        = number
  description = "Maximum autoscaling storage in GB."
  default     = 100
}

variable "multi_az" {
  type        = bool
  description = "Enable multi-AZ."
  default     = true
}

variable "backup_retention_period" {
  type        = number
  description = "Backup retention days."
  default     = 7
}

variable "deletion_protection" {
  type        = bool
  description = "Enable deletion protection."
  default     = true
}
