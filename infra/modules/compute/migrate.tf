# One-off migrate task. Reuses the API container image but overrides
# the command to run node-pg-migrate against the private RDS. Invoked
# from CI via `aws ecs run-task`, not as a service.

data "aws_caller_identity" "current" {}

locals {
  # ECR image URL the deploy-image job pushes to. Kept on a local so the
  # app task definition can switch to it in a later change without
  # reaching outside the module.
  migrate_container_image = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/${var.ecr_repository_name}:${var.migrate_image_tag}"
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name_prefix}-migrate"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "${local.name_prefix}-migrate-logs"
    Environment = var.environment
  }
}

# The task role (same one the service tasks use) also needs to read the
# RDS master-user secret when a future change moves URL assembly from
# CI into the container. Attached here so the capability is tracked in
# this module alongside the migrate task that would consume it.
data "aws_iam_policy_document" "task_rds_secret_read" {
  count = var.rds_master_user_secret_arn == "" ? 0 : 1

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.rds_master_user_secret_arn]
  }
}

resource "aws_iam_role_policy" "task_rds_secret_read" {
  count = var.rds_master_user_secret_arn == "" ? 0 : 1

  name   = "${local.name_prefix}-task-rds-secret-read"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_rds_secret_read[0].json
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-migrate"
  cpu                      = var.migrate_task_cpu
  memory                   = var.migrate_task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = var.container_name
      image     = local.migrate_container_image
      essential = true
      # Command override: run node-pg-migrate against the migrations
      # shipped into /app/migrations by the API Dockerfile. The CLI
      # lives in the self-contained /opt/migrate install (see
      # docker/api.Dockerfile) so the API's own node_modules stays
      # untouched. MIGRATION_DATABASE_URL is injected per run via
      # `aws ecs run-task --overrides`.
      command = [
        "node",
        "/opt/migrate/node_modules/.bin/node-pg-migrate",
        "up",
        "--no-check-order",
        "-m",
        "/app/migrations",
        "-d",
        "MIGRATION_DATABASE_URL",
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migrate.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = {
    Name        = "${local.name_prefix}-migrate"
    Environment = var.environment
  }
}
