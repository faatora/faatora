# Backend config for `terraform init -backend-config=environments/production.backend.hcl`.
# The S3 state bucket (`faatora-tfstate`) and the DynamoDB lock table
# (`fawtara-tflock`) both live in us-east-1 even though the production
# workload runs in eu-central-1. That is intentional: a Terraform state
# object is small, region-independent in effect, and keeping one bucket
# means one KMS / versioning / replication policy to audit instead of
# two. State and workload region are separate concerns.

bucket         = "faatora-tfstate"
key            = "production/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "fawtara-tflock"
encrypt        = true
