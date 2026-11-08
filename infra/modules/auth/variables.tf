variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "mfa_configuration" {
  type        = string
  description = "MFA mode: OFF, ON, OPTIONAL."
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "ON", "OPTIONAL"], var.mfa_configuration)
    error_message = "mfa_configuration must be one of OFF, ON, OPTIONAL."
  }
}

variable "client_name" {
  type        = string
  description = "Public app client name."
  default     = "web"
}
