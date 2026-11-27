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

# ClearTax §5.7 partner mTLS — OFF for now.
#
# Flip to true once ALL FOUR of the pieces below are in place:
#   1. The ClearTax ops CA bundle PEM has been uploaded to a dedicated
#      S3 bucket (ops-only, SSE-KMS, bucket policy restricting GetObject
#      to the ALB service principal — see docs/runbooks/cleartax-partner-access.md).
#   2. An ACM cert for the mTLS listener hostname has been issued in
#      eu-central-1 and its ARN is known.
#   3. ClearTax has sent the egress CIDRs for their partner-API clients
#      (set in `cleartax_partner_cidrs`).
#   4. The three CLEARTAX_PARTNER_* env vars in
#      infra/environments/production.env.json have been filled in with the
#      cert Subject CN, Issuer CN, and a comma-joined mirror of
#      cleartax_partner_cidrs.
#
# The resource preconditions in infra/modules/compute/mtls.tf refuse plan
# when enable_cleartax_mtls=true with any of the four variables below
# empty, which is the right fail-safe: a half-configured trust store
# would cheerfully accept any client cert signed by the empty CA list,
# i.e. none, and the listener would return 495 to every partner call.
#
# Keeping this flag off until the sealed tfvars overlay is ready means
# `terraform apply` on the production stack completes without touching
# the mTLS resources; the API's ClearTaxPartnerGuard separately returns
# 503 ("partner access not configured") until
# CLEARTAX_PARTNER_CERT_SUBJECT_CN is non-empty, so the overall posture
# is "refuse all partner traffic" rather than "accept it insecurely".
enable_cleartax_mtls         = false
cleartax_ca_bundle_s3_bucket = ""
cleartax_ca_bundle_s3_key    = ""
cleartax_partner_cidrs       = []
# alb_cert_arn intentionally left to its "" default here — it is only
# consumed when enable_cleartax_mtls=true.
