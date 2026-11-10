output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.app.name
}

output "task_definition_arn" {
  description = "ECS task definition ARN."
  value       = aws_ecs_task_definition.app.arn
}

output "task_role_arn" {
  description = "IAM role ARN assumed by the task."
  value       = aws_iam_role.task.arn
}

output "task_execution_role_arn" {
  description = "IAM role ARN used to pull images and write logs."
  value       = aws_iam_role.task_execution.arn
}

output "alb_arn" {
  description = "Application Load Balancer ARN."
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "Application Load Balancer DNS name."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Application Load Balancer canonical hosted zone id."
  value       = aws_lb.this.zone_id
}

output "target_group_arn" {
  description = "Target group ARN."
  value       = aws_lb_target_group.app.arn
}

output "log_group_name" {
  description = "CloudWatch log group name."
  value       = aws_cloudwatch_log_group.app.name
}

output "migrate_task_definition_arn" {
  description = "ARN of the one-off migrate task definition. Invoked by CI via `aws ecs run-task`."
  value       = aws_ecs_task_definition.migrate.arn
}

output "migrate_task_definition_family" {
  description = "Family name of the migrate task definition (useful when callers want the latest revision rather than a pinned ARN)."
  value       = aws_ecs_task_definition.migrate.family
}

output "migrate_log_group_name" {
  description = "CloudWatch log group that captures migrate-task output."
  value       = aws_cloudwatch_log_group.migrate.name
}

output "migrate_container_name" {
  description = "Container name inside the migrate task definition. CI uses it when passing env overrides to `aws ecs run-task`."
  value       = var.container_name
}
