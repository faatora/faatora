locals {
  name_prefix = "${var.project}-${var.environment}"
}

resource "aws_sqs_queue" "clearance_dlq" {
  name                      = "${local.name_prefix}-clearance-dlq"
  message_retention_seconds = var.message_retention_seconds
  kms_master_key_id         = var.kms_master_key_id

  tags = {
    Name        = "${local.name_prefix}-clearance-dlq"
    Environment = var.environment
    Role        = "dlq"
  }
}

resource "aws_sqs_queue" "clearance" {
  name                       = "${local.name_prefix}-clearance"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  kms_master_key_id          = var.kms_master_key_id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.clearance_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = {
    Name        = "${local.name_prefix}-clearance"
    Environment = var.environment
    Role        = "main"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq_allow" {
  queue_url = aws_sqs_queue.clearance_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.clearance.arn]
  })
}
