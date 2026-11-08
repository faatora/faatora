variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "max_receive_count" {
  type        = number
  description = "Max receives before messages are moved to the DLQ."
  default     = 5
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "Visibility timeout for the main queue."
  default     = 60
}

variable "message_retention_seconds" {
  type        = number
  description = "Message retention (seconds). 1209600 = 14 days."
  default     = 1209600
}

variable "kms_master_key_id" {
  type        = string
  description = "Optional CMK id/arn for SQS server-side encryption. Defaults to AWS managed alias."
  default     = "alias/aws/sqs"
}
