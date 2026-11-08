output "bucket_id" {
  description = "Archive S3 bucket name."
  value       = aws_s3_bucket.archive.id
}

output "bucket_arn" {
  description = "Archive S3 bucket ARN."
  value       = aws_s3_bucket.archive.arn
}

output "bucket_domain_name" {
  description = "Archive S3 bucket domain name."
  value       = aws_s3_bucket.archive.bucket_domain_name
}

output "bucket_regional_domain_name" {
  description = "Archive S3 bucket regional domain name."
  value       = aws_s3_bucket.archive.bucket_regional_domain_name
}
