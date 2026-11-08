output "clearance_queue_url" {
  description = "URL of the main clearance queue."
  value       = aws_sqs_queue.clearance.id
}

output "clearance_queue_arn" {
  description = "ARN of the main clearance queue."
  value       = aws_sqs_queue.clearance.arn
}

output "clearance_queue_name" {
  description = "Name of the main clearance queue."
  value       = aws_sqs_queue.clearance.name
}

output "dlq_url" {
  description = "URL of the clearance dead-letter queue."
  value       = aws_sqs_queue.clearance_dlq.id
}

output "dlq_arn" {
  description = "ARN of the clearance dead-letter queue."
  value       = aws_sqs_queue.clearance_dlq.arn
}

output "dlq_name" {
  description = "Name of the clearance dead-letter queue."
  value       = aws_sqs_queue.clearance_dlq.name
}
