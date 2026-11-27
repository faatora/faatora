# ClearTax §5.7 partner access — ALB mTLS listener + trust store.
#
# Why a dedicated listener rather than adding `mutual_authentication` to the
# public 443/80 listener: ALB mTLS applies to the entire listener, not per
# rule. Once a listener is set to `verify`, every request to it must present
# a valid client cert — the public ALB cannot host both unauthenticated
# traffic and the ClearTax mTLS surface on the same port. The partner
# endpoint therefore lives on its own port (default 8443) that forwards into
# the same target group; the Nest `ClearTaxPartnerGuard` still enforces path
# scope (/api/partners/cleartax/*), issuer CN, IP allowlist, and JWT role on
# top.
#
# The whole surface is gated behind `var.enable_cleartax_mtls` so staging
# can keep it switched off until the ClearTax ops CA bundle has been
# uploaded to S3 and the ACM cert ARN wired in. When the flag flips on and
# a required input is missing, the resource preconditions below make
# `terraform plan` fail loudly rather than apply a half-configured trust
# store (an empty bucket would leave ALB rejecting every TLS handshake).
#
# Operational flow is documented in docs/runbooks/cleartax-partner-access.md.

resource "aws_lb_trust_store" "cleartax" {
  count = var.enable_cleartax_mtls ? 1 : 0

  name                             = "${local.name_prefix}-cleartax-ts"
  ca_certificates_bundle_s3_bucket = var.cleartax_ca_bundle_s3_bucket
  ca_certificates_bundle_s3_key    = var.cleartax_ca_bundle_s3_key

  lifecycle {
    precondition {
      condition     = var.cleartax_ca_bundle_s3_bucket != "" && var.cleartax_ca_bundle_s3_key != ""
      error_message = "enable_cleartax_mtls=true requires both cleartax_ca_bundle_s3_bucket and cleartax_ca_bundle_s3_key to be set (see docs/runbooks/cleartax-partner-access.md)."
    }
    precondition {
      condition     = var.alb_cert_arn != ""
      error_message = "enable_cleartax_mtls=true requires alb_cert_arn (ACM cert for the listener) to be set."
    }
  }

  tags = {
    Name        = "${local.name_prefix}-cleartax-ts"
    Environment = var.environment
    Purpose     = "cleartax-mtls-partner-access"
  }
}

# Dedicated security group for the mTLS listener. Kept separate from the
# public ALB SG (owned by the network module) so partner-only ingress is
# restricted to `var.cleartax_partner_cidrs` without widening public 80/443
# or blurring ownership between modules.
resource "aws_security_group" "alb_mtls" {
  count = var.enable_cleartax_mtls ? 1 : 0

  name        = "${local.name_prefix}-alb-mtls-sg"
  description = "ALB ingress ${var.cleartax_mtls_port} from ClearTax partner CIDRs (mTLS)"
  vpc_id      = var.vpc_id

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    precondition {
      condition     = length(var.cleartax_partner_cidrs) > 0
      error_message = "enable_cleartax_mtls=true requires cleartax_partner_cidrs to list at least one CIDR — an empty list would leave the mTLS listener reachable from nowhere (and would also be a silent 'allow-all' hazard if the SG model ever changes). This should match CLEARTAX_PARTNER_IP_ALLOWLIST at the app layer; defense in depth."
    }
  }

  tags = {
    Name        = "${local.name_prefix}-alb-mtls-sg"
    Environment = var.environment
    Purpose     = "cleartax-mtls-partner-access"
  }
}

# Separate ingress rule resource (not an inline `ingress` block on the SG
# above) so the CIDR list is cleanly managed as one rule per CIDR and
# additions/removals don't rewrite the whole SG.
resource "aws_vpc_security_group_ingress_rule" "alb_mtls" {
  for_each = var.enable_cleartax_mtls ? toset(var.cleartax_partner_cidrs) : toset([])

  security_group_id = aws_security_group.alb_mtls[0].id
  description       = "ClearTax partner mTLS from ${each.value}"
  from_port         = var.cleartax_mtls_port
  to_port           = var.cleartax_mtls_port
  ip_protocol       = "tcp"
  cidr_ipv4         = each.value

  tags = {
    Name        = "${local.name_prefix}-alb-mtls-ingress"
    Environment = var.environment
  }
}

resource "aws_lb_listener" "cleartax_mtls" {
  count = var.enable_cleartax_mtls ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = var.cleartax_mtls_port
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_cert_arn

  mutual_authentication {
    mode            = "verify"
    trust_store_arn = aws_lb_trust_store.cleartax[0].arn
    # `ignore_client_certificate_expiration` would also pin expiry
    # enforcement to the ALB side, but the field isn't in the AWS provider
    # version the module targets. The default behavior (`false` — reject
    # expired client certs at the handshake) is what we want; the
    # application-layer guard also checks `notAfter` so we're belt-and-
    # braces either way.
  }

  # Same target group as the public listener — the Nest app distinguishes
  # partner vs public routes by path + `ClearTaxPartnerGuard`, not by
  # listener. The guard re-parses the PEM from `X-Amzn-Mtls-Clientcert`
  # that ALB forwards after a successful verify handshake.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  tags = {
    Name        = "${local.name_prefix}-cleartax-mtls-listener"
    Environment = var.environment
    Purpose     = "cleartax-mtls-partner-access"
  }
}
