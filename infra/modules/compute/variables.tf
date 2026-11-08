variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "vpc_id" {
  type        = string
  description = "VPC id where the ALB and ECS tasks live."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Public subnet ids for the ALB."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet ids for the ECS service tasks."
}

variable "alb_sg_id" {
  type        = string
  description = "Security group id to attach to the ALB."
}

variable "app_sg_id" {
  type        = string
  description = "Security group id to attach to the app tasks."
}

variable "container_image" {
  type        = string
  description = "Container image URI for the app task."
  default     = "placeholder:latest"
}

variable "container_name" {
  type        = string
  description = "Container name inside the task definition."
  default     = "app"
}

variable "container_port" {
  type        = number
  description = "Container port exposed to the ALB."
  default     = 3000
}

variable "task_cpu" {
  type        = number
  description = "Fargate task CPU units."
  default     = 512
}

variable "task_memory" {
  type        = number
  description = "Fargate task memory MiB."
  default     = 1024
}

variable "desired_count" {
  type        = number
  description = "Desired number of running tasks. 0 = nothing runs."
  default     = 0
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention days."
  default     = 30
}
