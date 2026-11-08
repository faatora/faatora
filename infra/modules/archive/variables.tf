variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "kms_key_id" {
  type        = string
  description = "KMS key id/arn used for server-side encryption."
}

variable "retention_days" {
  type        = number
  description = "Default Object Lock retention days (10 years = 3653)."
  default     = 3653
}

variable "glacier_transition_days" {
  type        = number
  description = "Days before transitioning current versions to Glacier Deep Archive."
  default     = 90
}
