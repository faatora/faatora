/**
 * ClearTax §5.7 declared-subcontractor commitment — 10-year archive inputs.
 * Numbers here mirror apps/api/src/db/schema/archive.ts
 * (GLACIER_IR_TRANSITION_DAYS, RETENTION_EXPIRATION_DAYS) so the bucket's
 * lifecycle agrees with the application layer's expectation.
 */

variable "project" {
  type        = string
  description = "Project name for resource naming."
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)."
}

variable "kms_key_id" {
  type        = string
  description = "KMS key id/arn used for server-side encryption."
}

variable "retention_days" {
  type        = number
  description = "Object Lock COMPLIANCE-mode retention days. OTA §5.7 = 10 years. 10 years * 365 = 3650, we add 3 days of slack for leap years."
  default     = 3653
}

variable "glacier_ir_transition_days" {
  type        = number
  description = "Days before transitioning STANDARD objects to GLACIER_IR. OTA §5.7 split: 5 years operational (STANDARD), 5 years cold archive (GLACIER_IR). 5 * 365 = 1825."
  default     = 1825
}

variable "expiration_days" {
  type        = number
  description = "Days before the Lifecycle rule expires (deletes) the object. OTA §5.7 ceiling: 10 years. 10 * 365 = 3650."
  default     = 3650
}

variable "admin_override_principals" {
  type        = list(string)
  description = "IAM principal ARNs allowed to delete archive objects before the 10-year expiration. Intended to be empty ([]) in production and populated only in-flight during a four-eyes-approved GDPR erasure workflow (see docs/runbooks/archive-mfa-delete.md). An empty list is normalised to a placeholder principal that matches nothing so the Deny statement still has a valid NotPrincipal."
  default     = []
}
