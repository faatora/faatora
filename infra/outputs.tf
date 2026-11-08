# Root outputs. All are gated behind var.enable_infra so they are null
# when the stack is not materialised.

output "vpc_id" {
  description = "VPC id."
  value       = var.enable_infra ? module.network[0].vpc_id : null
}

output "private_subnet_ids" {
  description = "Private subnet ids."
  value       = var.enable_infra ? module.network[0].private_subnet_ids : []
}

output "public_subnet_ids" {
  description = "Public subnet ids."
  value       = var.enable_infra ? module.network[0].public_subnet_ids : []
}

# ---- Auth / Cognito ----

output "cognito_user_pool_id" {
  description = "Cognito user pool id."
  value       = var.enable_infra ? module.auth[0].user_pool_id : null
}

output "cognito_user_pool_arn" {
  description = "Cognito user pool ARN."
  value       = var.enable_infra ? module.auth[0].user_pool_arn : null
}

output "cognito_client_id" {
  description = "Cognito public app client id."
  value       = var.enable_infra ? module.auth[0].client_id : null
}

# ---- KMS ----

output "kms_signing_key_arn" {
  description = "KMS ARN for the invoice signing key."
  value       = var.enable_infra ? module.kms[0].signing_key_arn : null
}

output "kms_data_key_arn" {
  description = "KMS ARN for the tenant data encryption key."
  value       = var.enable_infra ? module.kms[0].data_key_arn : null
}

# ---- Queue ----

output "clearance_queue_url" {
  description = "SQS URL for the clearance queue."
  value       = var.enable_infra ? module.queue[0].clearance_queue_url : null
}

output "clearance_queue_arn" {
  description = "SQS ARN for the clearance queue."
  value       = var.enable_infra ? module.queue[0].clearance_queue_arn : null
}

output "clearance_dlq_url" {
  description = "SQS URL for the clearance DLQ."
  value       = var.enable_infra ? module.queue[0].dlq_url : null
}

# ---- Archive ----

output "archive_bucket_id" {
  description = "Name of the WORM archive S3 bucket."
  value       = var.enable_infra ? module.archive[0].bucket_id : null
}

output "archive_bucket_arn" {
  description = "ARN of the WORM archive S3 bucket."
  value       = var.enable_infra ? module.archive[0].bucket_arn : null
}

# ---- Database ----

output "db_endpoint" {
  description = "RDS endpoint (host:port)."
  value       = var.enable_infra ? module.database[0].endpoint : null
}

output "db_master_user_secret_arn" {
  description = "ARN of the managed master-user secret for the DB."
  value       = var.enable_infra ? module.database[0].master_user_secret_arn : null
  sensitive   = true
}

# ---- Compute / ALB ----

output "alb_dns_name" {
  description = "Public DNS name of the application load balancer."
  value       = var.enable_infra ? module.compute[0].alb_dns_name : null
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = var.enable_infra ? module.compute[0].cluster_name : null
}

output "ecs_service_name" {
  description = "ECS service name."
  value       = var.enable_infra ? module.compute[0].service_name : null
}
