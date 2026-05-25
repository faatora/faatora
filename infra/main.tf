# Modules are added per-epic as AWS access is confirmed:
#   module "network"  -> VPC, subnets, ALB        (EP1 deploy)
#   module "database" -> RDS Postgres (Multi-AZ)  (EP1 deploy)
#   module "compute"  -> ECS Fargate API service  (EP1 deploy)
#   module "auth"     -> Cognito user pool         (EP2)
#   module "kms"      -> signing + data keys       (EP5)
#   module "queue"    -> SQS + DLQ                  (EP6)
#   module "storage"  -> S3 (Object Lock archive)  (EP8)

# Placeholder so `terraform plan` succeeds with zero resources and proves the
# OIDC + remote-state + pipeline chain end to end.
