# Production — eu-central-1 (Frankfurt) for PDPL/GDPR data residency.
# This is a greenfield stack: no state exists yet. First apply will be
# driven by `.github/workflows/deploy-production.yml` once Ahmed has
# followed infra/MIGRATION-TO-EU-CENTRAL-1.md end to end.
#
# vpc_cidr is deliberately distinct from staging's 10.20.0.0/16 so the
# two VPCs can be peered later without re-addressing either side.
# az_count=3 gives production a third AZ; the network module carves
# /20 public and /20 private subnets with cidrsubnet(), so this
# produces public 10.21.{0,16,32}.0/20 and private 10.21.{48,64,80}.0/20.

project      = "faatora"
environment  = "production"
aws_region   = "eu-central-1"
vpc_cidr     = "10.21.0.0/16"
az_count     = 3
db_multi_az  = true
enable_infra = true
