variable "aws_region" {
  type        = string
  description = "AWS region the stack is deployed to. No default on purpose: the caller must pass it (via -var-file=environments/<env>.tfvars) so a run can never land in the wrong region by accident."
}

variable "environment" {
  type        = string
  description = "Deployment environment (staging, production). Used as the second half of every name prefix and to drive per-env tfvars selection."
}

variable "project" {
  type    = string
  default = "faatora"
}

variable "enable_infra" {
  type    = bool
  default = false
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC created by the network module."
  default     = "10.20.0.0/16"
}

variable "az_count" {
  type        = number
  description = "Number of AZs (and matching pairs of public/private subnets) to provision. Staging runs 2; production runs 3 to meet PDPL/GDPR resiliency expectations."
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4 (we only carve /20 subnet pairs out of a /16 for up to 4 AZs)."
  }
}

variable "db_multi_az" {
  type        = bool
  description = "Enable multi-AZ for the primary RDS instance."
  default     = true
}

# ---------------------------------------------------------------
# ClearTax §5.7 partner mTLS. Wired straight through to module.compute;
# see infra/modules/compute/mtls.tf and
# docs/runbooks/cleartax-partner-access.md.
# ---------------------------------------------------------------

variable "enable_cleartax_mtls" {
  type        = bool
  description = "Provision the ALB mTLS listener + trust store for ClearTax §5.7 partner access. Staging stays false until the CA bundle is uploaded; production ships true, and the four supporting vars below must be supplied at apply time (via a sealed tfvars file or -var) — resource preconditions fail plan otherwise."
  default     = false
}

variable "cleartax_ca_bundle_s3_bucket" {
  type        = string
  description = "S3 bucket holding the ClearTax ops CA PEM bundle (required when enable_cleartax_mtls=true). Not committed to env tfvars — supplied at apply time."
  default     = ""
}

variable "cleartax_ca_bundle_s3_key" {
  type        = string
  description = "S3 key of the CA bundle (required when enable_cleartax_mtls=true). Not committed to env tfvars — supplied at apply time."
  default     = ""
}

variable "cleartax_mtls_port" {
  type        = number
  description = "Listener port for the mTLS partner endpoint. Defaults to 8443."
  default     = 8443
}

variable "cleartax_partner_cidrs" {
  type        = list(string)
  description = "Source CIDRs permitted to reach the mTLS listener. Must match CLEARTAX_PARTNER_IP_ALLOWLIST at the app layer. Empty list refuses plan when enable_cleartax_mtls=true."
  default     = []
}

variable "alb_cert_arn" {
  type        = string
  description = "ACM cert ARN used by the mTLS listener's server-side TLS (required when enable_cleartax_mtls=true). Not committed to env tfvars — supplied at apply time."
  default     = ""
}
