# Staging — stays in us-east-1 forever. Do not change the region here:
# the staging RDS, S3 WORM archive, Cognito user pool and ECR repo all
# live in us-east-1 and the state key `staging/terraform.tfstate` points
# at that layout. See infra/README.md for the per-env workflow.

project      = "faatora"
environment  = "staging"
aws_region   = "us-east-1"
vpc_cidr     = "10.20.0.0/16"
az_count     = 2
db_multi_az  = true
enable_infra = true
