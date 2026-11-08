variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "deletion_window_in_days" {
  type        = number
  description = "KMS key deletion window."
  default     = 30
}
