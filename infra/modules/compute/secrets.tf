# ---------------------------------------------------------------
# Task-execution-role grants for Secrets Manager values referenced
# by the API container's task definition via the `secrets:` block.
#
# ECS resolves every entry of `containerDefinitions[].secrets[]` at
# task START, before the container's PID 1 runs, using the TASK
# EXECUTION role (not the task role). Any `valueFrom` ARN the role
# cannot `secretsmanager:GetSecretValue` on surfaces as a
# `ResourceInitializationError: unable to pull secrets or registry
# auth` task-stop reason, with `failedTasks` ticking up on the
# rolling deployment — exactly the failure mode staging hit after
# PR #39 added `{name:"COGNITO_CLIENT_SECRET", valueFrom:<SM ARN>}`
# to infra/environments/{staging,production}.env.json.
#
# The companion RDS master-user-secret grant lives on the TASK role
# (not task-execution) in migrate.tf, because the migrate task reads
# that secret from inside the container via the AWS SDK rather than
# through the ECS `secrets:` resolution path. The two grants are
# deliberately kept separate so the capability each role carries
# stays minimal and inspectable.
#
# KMS: aws_secretsmanager_secret.cognito_client_secret in
# infra/modules/auth/main.tf does NOT set a `kms_key_id`, so the
# secret is encrypted with the AWS-managed `aws/secretsmanager` KMS
# CMK. The account implicitly holds `kms:Decrypt` on that key when
# the request is routed through Secrets Manager, so no extra
# `kms:Decrypt` grant is required here. If a future change switches
# the secret to a customer-managed CMK, this policy must gain a
# `kms:Decrypt` statement against that key's ARN.
# ---------------------------------------------------------------

data "aws_iam_policy_document" "task_execution_cognito_secret_read" {
  count = var.cognito_client_secret_arn == "" ? 0 : 1

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.cognito_client_secret_arn]
  }
}

resource "aws_iam_role_policy" "task_execution_cognito_secret_read" {
  count = var.cognito_client_secret_arn == "" ? 0 : 1

  name   = "${local.name_prefix}-task-exec-cognito-secret-read"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_cognito_secret_read[0].json
}
