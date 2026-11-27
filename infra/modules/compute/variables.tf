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

variable "cognito_client_secret_arn" {
  type        = string
  description = "ARN of the Secrets Manager secret the API task definition references through `secrets:[{name:COGNITO_CLIENT_SECRET, valueFrom:<arn>}]` (see PR #39's env overlay). ECS resolves `secrets[].valueFrom` via the TASK EXECUTION role at task start, so the role is granted `secretsmanager:GetSecretValue` on this ARN. Empty string disables the grant for dev/CI stacks that do not provision the Cognito client secret; the ECS task start-up will then fail with a ResourceInitializationError the moment the overlay references the ARN, which is intentionally loud. The secret is encrypted with the AWS-managed `aws/secretsmanager` KMS key (see `infra/modules/auth/main.tf` — no `kms_key_id` is set on `aws_secretsmanager_secret.cognito_client_secret`), so no explicit `kms:Decrypt` grant is needed; the account implicitly holds Decrypt on the AWS-managed key."
  default     = ""
}

variable "ecr_repository_name" {
  type        = string
  description = "Name of the ECR repository the deploy-image job pushes to. The migrate task definition references $${account}.dkr.ecr.$${region}.amazonaws.com/$${name}:staging so a reused image always matches the tag the deploy pipeline publishes."
  default     = "faatora-api"
}

variable "migrate_image_tag" {
  type        = string
  description = "Image tag on the ECR repo that the migrate task resolves to at run time. 'staging' is the moving tag the deploy-image job always updates; pin to a sha for repeatable runs."
  default     = "staging"
}

# ---------------------------------------------------------------
# ClearTax §5.7 partner mTLS (see mtls.tf and
# docs/runbooks/cleartax-partner-access.md).
# ---------------------------------------------------------------

variable "enable_cleartax_mtls" {
  type        = bool
  description = "Set to true to provision the mTLS listener + trust store for ClearTax §5.7 partner access. When true, cleartax_ca_bundle_s3_bucket/key, alb_cert_arn and cleartax_partner_cidrs must all be set — resource preconditions fail plan otherwise."
  default     = false
}

variable "cleartax_ca_bundle_s3_bucket" {
  type        = string
  description = "S3 bucket holding the concatenated PEM CA bundle for the ClearTax ops CA (required when enable_cleartax_mtls=true). The ALB Trust Store syncs from s3://<bucket>/<key>."
  default     = ""
}

variable "cleartax_ca_bundle_s3_key" {
  type        = string
  description = "S3 key of the CA bundle (required when enable_cleartax_mtls=true). Rotation: upload a new PEM to the same key; the trust store refreshes within ~15 min."
  default     = ""
}

variable "cleartax_mtls_port" {
  type        = number
  description = "Listener port for the mTLS partner endpoint. Kept off 443 because mTLS applies to the whole listener and would block all unauthenticated public traffic. Defaults to 8443."
  default     = 8443
}

variable "cleartax_partner_cidrs" {
  type        = list(string)
  description = "Source CIDRs permitted to reach the mTLS listener. Should match CLEARTAX_PARTNER_IP_ALLOWLIST at the app layer; defense in depth. Empty list = refuses to apply when enable_cleartax_mtls=true (see mtls.tf precondition)."
  default     = []
}

variable "alb_cert_arn" {
  type        = string
  description = "ACM cert ARN for the mTLS listener's server-side TLS. Required when enable_cleartax_mtls=true. Can reuse the same cert the public 443 listener will carry — the mTLS listener only differs in the mutual_authentication block and the dedicated SG."
  default     = ""
}
