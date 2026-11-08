output "signing_key_id" {
  description = "KMS key id for invoice signing."
  value       = aws_kms_key.signing.key_id
}

output "signing_key_arn" {
  description = "KMS key ARN for invoice signing."
  value       = aws_kms_key.signing.arn
}

output "signing_key_alias" {
  description = "KMS alias for the signing key."
  value       = aws_kms_alias.signing.name
}

output "data_key_id" {
  description = "KMS key id for tenant data encryption."
  value       = aws_kms_key.data.key_id
}

output "data_key_arn" {
  description = "KMS key ARN for tenant data encryption."
  value       = aws_kms_key.data.arn
}

output "data_key_alias" {
  description = "KMS alias for the data key."
  value       = aws_kms_alias.data.name
}
