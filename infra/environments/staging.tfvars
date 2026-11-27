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

# ClearTax §5.7 partner mTLS stays off in staging until the ClearTax ops
# CA bundle has been uploaded to S3 and `cleartax_ca_bundle_s3_*`,
# `alb_cert_arn` and `cleartax_partner_cidrs` are supplied via a sealed
# tfvars file. Flipping this flag on with any of those unset will fail
# `terraform plan` on purpose (see infra/modules/compute/mtls.tf
# preconditions and docs/runbooks/cleartax-partner-access.md).
enable_cleartax_mtls = false
