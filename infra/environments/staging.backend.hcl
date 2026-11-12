# Backend config for `terraform init -backend-config=environments/staging.backend.hcl`.
# The state bucket and lock table both live in us-east-1 regardless of
# the workload region (this environment is us-east-1 anyway).

bucket         = "faatora-tfstate"
key            = "staging/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "fawtara-tflock"
encrypt        = true
