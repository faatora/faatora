/**
 * ClearTax §5.7 declared-subcontractor commitment — 10-year archive bucket.
 *
 * OTA rule implemented: Fawtara §5.7 retention — 5 years operational + 5
 * years cold archive = 10 years total from the signing / clearance date.
 *
 * Storage tier plan:
 *   - Year 0-5  (days 0-1824):    S3 STANDARD (synchronous reads, highest cost).
 *   - Year 5-10 (days 1825-3649): S3 GLACIER_IR (Glacier Instant Retrieval —
 *                                 synchronous reads at ~1/6 the storage cost
 *                                 of STANDARD, no RestoreObject step).
 *   - Day 3650+:                  Lifecycle Expiration deletes the object.
 *
 * Immutability:
 *   - Object Lock in COMPLIANCE mode with a 10-year retain-until so no one,
 *     including the root account, can delete an object before its retain-
 *     until date passes.
 *   - Versioning is enabled (Object Lock requires it); MFA Delete is
 *     documented as a post-apply manual step because Terraform cannot
 *     enable MFA Delete via the S3 API (requires the bucket owner's root
 *     credentials and an MFA token — see docs/runbooks/archive-mfa-delete.md).
 *   - A bucket policy denies s3:DeleteObject and s3:DeleteObjectVersion to
 *     every principal that is NOT in the admin-override list, for the full
 *     10-year window. The admin override is intended for the rare "GDPR
 *     erasure of a client who closed their firm" scenario and MUST be
 *     executed under four-eyes approval (see the runbook).
 */

locals {
  name_prefix = "${var.project}-${var.environment}"
  # Full ARN of every object inside the archive bucket. Used by the
  # delete-denial statement below.
  object_arn_wildcard = "arn:aws:s3:::${aws_s3_bucket.archive.id}/*"
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "archive" {
  bucket              = "${var.project}-${var.environment}-archive-${random_id.suffix.hex}"
  object_lock_enabled = true
  force_destroy       = false

  tags = {
    Name        = "${local.name_prefix}-archive"
    Environment = var.environment
    Purpose     = "worm-archive-10y"
    OtaRule     = "fawtara-5.7-retention"
  }
}

# Versioning + MFA Delete.
#
# `mfa_delete = "Disabled"` is intentional and Terraform cannot change it:
# enabling MFA Delete requires the bucket owner's root credentials and an
# MFA code (see https://docs.aws.amazon.com/AmazonS3/latest/userguide/MultiFactorAuthenticationDelete.html).
# After `terraform apply` in production, the archive runbook
# (docs/runbooks/archive-mfa-delete.md) walks the on-call through the manual
# `aws s3api put-bucket-versioning --mfa "<serial> <code>" --versioning-configuration Status=Enabled,MFADelete=Enabled`
# invocation. The bucket-policy-level delete denial below is the floor
# until that manual step runs.
resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status     = "Enabled"
    mfa_delete = "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_id
    }
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_object_lock_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

# 10-year lifecycle: STANDARD for the first 5 years, GLACIER_IR for the
# second 5 years, hard expiration at 10 years.
#
# Scope note: this rule applies to NEWLY-WRITTEN objects. Existing
# archive_records objects already under the previous "transition to Deep
# Archive at 90 days + expire at 5 years" rule need a one-off re-tagging
# migration — see the "Manual follow-ups" section of the PR body.
resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "ota-5.7-10yr-retention"
    status = "Enabled"

    # Empty filter == apply to every object in the bucket.
    filter {}

    # 5 years of hot storage before we flip to Glacier Instant Retrieval.
    # GLACIER_IR is a synchronous read class — no RestoreObject needed, see
    # apps/api/src/modules/archive/glacier-reader.ts for the cost note.
    transition {
      days          = var.glacier_ir_transition_days
      storage_class = "GLACIER_IR"
    }

    # Noncurrent versions follow the same transition schedule so a
    # mistakenly-overwritten object (one of the delete-denial policy's
    # edge cases) still ends up on the cold tier.
    noncurrent_version_transition {
      noncurrent_days = var.glacier_ir_transition_days
      storage_class   = "GLACIER_IR"
    }

    # 10-year expiration — matches the OTA §5.7 retention ceiling AND the
    # Object Lock retain-until date, so the object becomes genuinely
    # deletable only after the lock has lapsed.
    expiration {
      days = var.expiration_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.expiration_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

# Bucket policy — belt-and-braces delete denial on top of Object Lock.
#
# Object Lock in COMPLIANCE mode already blocks deletes before the retain-
# until date for every principal including root. The bucket policy adds a
# second layer that:
#   1. Denies s3:DeleteObject and s3:DeleteObjectVersion to every principal
#      NOT in var.admin_override_principals.
#   2. Denies disabling or weakening object-lock + versioning + public-
#      access-block so an attacker who temporarily gained admin cannot
#      silently neutralise the retention controls before deleting.
# The admin override exists for the one legitimate "GDPR erasure after a
# firm closes" scenario documented in docs/runbooks/archive-mfa-delete.md,
# and is intended to be empty in production environments by default.
#
# When no admin override is configured, we fall back to the account root
# ARN. An earlier version used arn:aws:iam::000000000000:root as a
# placeholder, which S3 rejects at PutBucketPolicy time with
# "MalformedPolicy: Invalid principal in policy" — the all-zero account
# id doesn't exist. Routing through the current account root keeps the
# policy valid; it also makes the override list effectively "no one
# outside this account can delete", which is a sensible default anyway.
data "aws_caller_identity" "current" {}

locals {
  # Fallback principal set when the caller provided none. The caller's
  # own account root is a valid ARN that S3 accepts and an intuitive
  # default for the admin-override list.
  _default_admin_principals = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
  _admin_principals         = length(var.admin_override_principals) > 0 ? var.admin_override_principals : local._default_admin_principals
}

data "aws_iam_policy_document" "archive_retention" {
  # Block object + version deletes for anyone not on the admin override.
  # NotPrincipal only works in Deny statements, which is exactly what we
  # want: deny unless you are explicitly in the allowed set.
  statement {
    sid    = "DenyDeletesBefore10Years"
    effect = "Deny"

    not_principals {
      type        = "AWS"
      identifiers = local._admin_principals
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]

    resources = [local.object_arn_wildcard]
  }

  # Block attempts to weaken the retention controls themselves.
  statement {
    sid    = "DenyRetentionControlWeakening"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = [
      "s3:PutBucketVersioning",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:PutBucketPublicAccessBlock",
      "s3:DeleteBucketPolicy",
    ]

    resources = [
      aws_s3_bucket.archive.arn,
      local.object_arn_wildcard,
    ]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = local._admin_principals
    }
  }
}

resource "aws_s3_bucket_policy" "archive_retention" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.archive_retention.json

  depends_on = [
    aws_s3_bucket_public_access_block.archive,
    aws_s3_bucket_object_lock_configuration.archive,
  ]
}
