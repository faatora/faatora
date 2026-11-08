output "user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Cognito user pool endpoint (issuer)."
  value       = aws_cognito_user_pool.this.endpoint
}

output "client_id" {
  description = "Cognito app client id (public, no secret)."
  value       = aws_cognito_user_pool_client.this.id
}
