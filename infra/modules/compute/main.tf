locals {
  name_prefix = "${var.project}-${var.environment}"
}

# ---------------------------------------------------------------
# ALB
# ---------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  subnets            = var.public_subnet_ids

  idle_timeout               = 60
  drop_invalid_header_fields = true

  tags = {
    Name        = "${local.name_prefix}-alb"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-app-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name        = "${local.name_prefix}-app-tg"
    Environment = var.environment
  }
}

# NOTE: TLS/443 listener needs a certificate; using HTTP:80 for now.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------
# ECS cluster, task role, log group
# ---------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = "${local.name_prefix}-cluster"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}-app"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "${local.name_prefix}-app-logs"
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json

  tags = {
    Name        = "${local.name_prefix}-task-exec"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json

  tags = {
    Name        = "${local.name_prefix}-task"
    Environment = var.environment
  }
}

# ---------------------------------------------------------------
# Task definition (placeholder image, no secrets wired yet).
# ---------------------------------------------------------------

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-app"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = var.container_name
      image     = var.container_image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = {
    Name        = "${local.name_prefix}-app"
    Environment = var.environment
  }

  # Terraform bootstraps this task-def with a placeholder image
  # (var.container_image defaults to "placeholder:latest") so the
  # service can be created before any API image exists in ECR. Every
  # subsequent apply would otherwise re-register this exact same
  # placeholder revision, superseding whatever real-image revision
  # the deploy workflow's register-task-definition step just pushed
  # and racing the service back to CannotPullContainerError on
  # docker.io/library/placeholder:latest. Ignoring
  # container_definitions here hands ownership of the image/env/log
  # config to the deploy pipeline from the second deploy onwards.
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

data "aws_region" "current" {}

# ---------------------------------------------------------------
# Service — desired_count defaults to 0 so nothing runs.
# ---------------------------------------------------------------

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-app"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  # The deploy workflow's update-service step repoints the service at
  # a freshly-registered task-def revision (see register-task-def
  # step in .github/workflows/deploy-staging.yml). If Terraform kept
  # ownership of task_definition, every apply would race the service
  # back to its own placeholder revision and recreate the
  # CannotPullContainerError crashloop. ignore_changes on both
  # desired_count (set by the deploy pipeline when scaling) and
  # task_definition (set by the deploy pipeline on each image push)
  # keeps Terraform in charge of the service's structural config
  # (network, SGs, load-balancer binding) and the pipeline in charge
  # of the rolling image updates.
  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [aws_lb_listener.http]

  tags = {
    Name        = "${local.name_prefix}-app"
    Environment = var.environment
  }
}
