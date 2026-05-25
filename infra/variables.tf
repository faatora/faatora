variable "aws_region" {
  description = "Region where workloads (RDS, ECS, archive) are created."
  type        = string
  default     = "me-south-1"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
}

variable "project" {
  type    = string
  default = "fawtara"
}
