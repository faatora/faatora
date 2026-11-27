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

output "cognito_client_secret_arn" {
  description = "ARN of the Secrets Manager placeholder that holds the Cognito app client secret. Terraform creates the resource; the operator writes the value via `aws secretsmanager put-secret-value` after the app client is minted. The ECS task definition pulls this via `secrets:[{name:COGNITO_CLIENT_SECRET, valueFrom:<this ARN>}]`."
  value       = aws_secretsmanager_secret.cognito_client_secret.arn
}
