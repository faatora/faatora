locals {
  name_prefix = "${var.project}-${var.environment}"
}

# Invoice signing key: asymmetric RSA for SIGN_VERIFY.
resource "aws_kms_key" "signing" {
  description              = "${local.name_prefix} invoice signing key"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days  = var.deletion_window_in_days
  # Rotation is not supported on asymmetric keys.
  enable_key_rotation = false

  tags = {
    Name        = "${local.name_prefix}-signing"
    Environment = var.environment
    Purpose     = "invoice-signing"
  }
}

resource "aws_kms_alias" "signing" {
  name          = "alias/${local.name_prefix}-signing"
  target_key_id = aws_kms_key.signing.key_id
}

# Tenant data encryption key: symmetric, rotation on.
resource "aws_kms_key" "data" {
  description              = "${local.name_prefix} tenant data encryption key"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  deletion_window_in_days  = var.deletion_window_in_days

  tags = {
    Name        = "${local.name_prefix}-data"
    Environment = var.environment
    Purpose     = "tenant-data"
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}
