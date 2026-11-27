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

# ClearTax §5.7 partner mTLS is ON in production. The sensitive inputs
# (CA bundle S3 bucket/key, ACM cert ARN, partner CIDRs) are deliberately
# NOT committed here — the deploy workflow applies with a second sealed
# tfvars file (see docs/runbooks/cleartax-partner-access.md) that sets:
#   cleartax_ca_bundle_s3_bucket = "..."
#   cleartax_ca_bundle_s3_key    = "cleartax-ops-ca.pem"
#   alb_cert_arn                 = "arn:aws:acm:eu-central-1:...:certificate/..."
#   cleartax_partner_cidrs       = ["203.0.113.0/24", ...]
# If any of those four is empty at plan time, the resource preconditions
# in infra/modules/compute/mtls.tf fail the plan with an actionable
# message rather than materialising a half-configured trust store.
enable_cleartax_mtls = true
