locals {
  name_prefix = "${var.project}-${var.environment}"
}

resource "aws_cognito_user_pool" "this" {
  name = "${local.name_prefix}-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  mfa_configuration = var.mfa_configuration

  dynamic "software_token_mfa_configuration" {
    for_each = var.mfa_configuration == "OFF" ? [] : [1]
    content {
      enabled = true
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  tags = {
    Name        = "${local.name_prefix}-users"
    Environment = var.environment
  }
}

resource "aws_cognito_user_pool_client" "this" {
  name         = "${local.name_prefix}-${var.client_name}"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  supported_identity_providers = ["COGNITO"]
}

# ---------------------------------------------------------------------------
# Cognito app client secret (Secrets Manager placeholder).
#
# The Cognito app client resource above is configured with
# `generate_secret = false` because the web SPA and public mobile POS app
# don't use SECRET_HASH. The accountant impersonation flow and the
# server-side CognitoAuthService (see apps/api/src/modules/auth/) do
# support SECRET_HASH when a client secret is present; when the operator
# decides to move to a confidential-client posture they:
#   1. Create (or switch to) a Cognito app client that has `generate_secret = true`.
#   2. Copy the client secret from the Cognito console.
#   3. Write it into the placeholder below via `aws secretsmanager put-secret-value`.
#
# Terraform owns the Secrets Manager resource (so IAM access patterns and
# naming live in-repo and are reviewable) but NEVER owns the value. The
# `lifecycle { ignore_changes = [secret_string] }` block on the version
# resource makes every subsequent `terraform apply` leave the console-set
# value alone — without it, apply would clobber the real secret back to
# "PLACEHOLDER_SET_VIA_CONSOLE" on every run.
#
# Fail-safe: CognitoAuthService treats COGNITO_CLIENT_SECRET=="PLACEHOLDER_SET_VIA_CONSOLE"
# as "no secret configured" and falls back to the no-SECRET_HASH path, so
# the API boots and auth continues to work until the operator fills it in.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "cognito_client_secret" {
  name        = "${local.name_prefix}-cognito-client-secret"
  description = "Cognito app client secret. Operator fills via SM console after the app client is minted with generate_secret=true; see docs/runbooks/prod-env-provisioning.md."

  tags = {
    Name        = "${local.name_prefix}-cognito-client-secret"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "cognito_client_secret_initial" {
  secret_id     = aws_secretsmanager_secret.cognito_client_secret.id
  secret_string = "PLACEHOLDER_SET_VIA_CONSOLE"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
