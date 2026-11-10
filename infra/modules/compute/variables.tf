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

variable "migrate_task_cpu" {
  type        = number
  description = "Fargate CPU units for the one-off migrate task."
  default     = 256
}

variable "migrate_task_memory" {
  type        = number
  description = "Fargate memory (MiB) for the one-off migrate task."
  default     = 512
}

variable "rds_master_user_secret_arn" {
  type        = string
  description = "ARN of the RDS master-user secret. The task role is granted secretsmanager:GetSecretValue on this ARN so future revisions of the migrate task can fetch credentials from inside the container. Empty string disables the grant (useful before the DB module has produced the ARN)."
  default     = ""
}

variable "ecr_repository_name" {
  type        = string
  description = "Name of the ECR repository the deploy-image job pushes to. The migrate task definition references `${account}.dkr.ecr.${region}.amazonaws.com/${name}:staging` so a reused image always matches the tag the deploy pipeline publishes."
  default     = "faatora-api"
}

variable "migrate_image_tag" {
  type        = string
  description = "Image tag on the ECR repo that the migrate task resolves to at run time. 'staging' is the moving tag the deploy-image job always updates; pin to a sha for repeatable runs."
  default     = "staging"
}
