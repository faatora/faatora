# Runbook — ClearTax partner access

**Severity:** Any disruption to this surface blocks an OTA inspection in flight. Treat a 403 spike or a cert near expiry with incident urgency; treat a 503 ("partner access not configured") during normal operations as **P0** — the route has become unreachable to ClearTax.

## What this route is

Under Faatora's §5.7 declared-subcontractor arrangement, ClearTax (the accredited OTA access point) is permitted to read any firm's hash-chained audit trail during an OTA inspection. The route is:

```
GET /partners/cleartax/firms/:firmId/audit
    ?tenantId=<uuid>   (optional — scope to one client tenant)
    &limit=<n>         (1..500, default 50)
    &since=<ISO8601>   (optional — only events on/after this instant)
```

The route is gated by `ClearTaxPartnerGuard` (`apps/api/src/auth/cleartax-partner.guard.ts`). All three independent checks must pass:

1. **mTLS client cert.** ALB terminates mutual-TLS, verifies the chain against the trust store, and forwards the PEM (URL-encoded) in `X-Amzn-Mtls-Clientcert`. The guard re-parses the cert and asserts Subject CN, Issuer CN and `notAfter > now()`.
2. **Source-IP allowlist.** The first entry of `X-Forwarded-For` (set by ALB) must sit inside one of the CIDRs in `CLEARTAX_PARTNER_IP_ALLOWLIST`. An empty allowlist means **block all** (fail-closed), NOT allow-all.
3. **Bearer JWT with role.** `Authorization: Bearer <jwt>` is verified by the standard Cognito verifier and must carry `custom:role` (or bare `role`) equal to `clearance-partner`.

Failure codes: **503** when env is not configured, **401** when the mTLS header is absent, **403** on any other check failure.

## ALB listener (mutual-TLS) configuration

The listener in `infra/modules/alb` (NOTE: module scaffold is the follow-up PR after this one — not yet present as of this runbook's creation) needs the `mutual_authentication` block in Terraform:

```hcl
resource "aws_lb_listener" "api_443" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.api.arn

  mutual_authentication {
    mode            = "verify"               # require + verify the client cert
    trust_store_arn = aws_lb_trust_store.cleartax.arn
    # ignore_client_certificate_expiration = false   (default — reject expired)
  }

  default_action { type = "forward"; target_group_arn = aws_lb_target_group.api.arn }
}

resource "aws_lb_trust_store" "cleartax" {
  name                             = "cleartax-partner-ca"
  ca_certificates_bundle_s3_bucket = aws_s3_bucket.trust_store.bucket
  ca_certificates_bundle_s3_key    = "cleartax-ops-ca.pem"
}
```

A `verify` mode listener rejects any request without a trusted client cert before the request reaches the app, so a plain `curl https://api.faatora.om/partners/cleartax/...` without a cert is dropped at the ALB (TLS handshake failure) and does not even show up as a 401 in the API logs. ALB sets `X-Amzn-Mtls-Clientcert` to the URL-encoded PEM; the API re-parses it as defence in depth.

**Follow-up:** the Terraform above belongs in `infra/modules/alb/main.tf`; the module does not exist yet. Track under its own PR after this one lands.

## Environment variables

Set in the ECS task definition secrets (via AWS Secrets Manager) for the `api` service. All three MUST be set in production; absence of the first two → guard returns 503.

| Env | Purpose | Example |
|---|---|---|
| `CLEARTAX_PARTNER_CERT_SUBJECT_CN` | Exact Subject CN the inbound mTLS cert must present. Compared string-for-string. | `ops.cleartax.om` |
| `CLEARTAX_PARTNER_ISSUER_CN` | Exact Issuer CN of the ClearTax ops CA. Guards against a self-signed cert with a spoofed Subject CN. | `ClearTax Ops CA` |
| `CLEARTAX_PARTNER_IP_ALLOWLIST` | Comma-separated CIDRs (v4 and/or v6). Empty = block all (fail-closed). | `203.0.113.0/24,2401:db00::/32` |

Local development: leave `CLEARTAX_PARTNER_CERT_SUBJECT_CN` unset. The guard short-circuits to 503, never to an accidental 200.

## Rotating the ClearTax partner certificate

ClearTax hands us a new partner cert ahead of the current one's `notAfter`. Rotation is zero-downtime because the trust store is a bundle of acceptable CAs, not a single pin.

1. **Receive the new cert bundle from ClearTax.** It is the new PEM-encoded client cert plus, if it changed, the new issuing CA bundle. Verify it off-channel with your ClearTax account contact (hash over Signal/secure email); the bundle never comes to us by email alone.
2. **Inspect the new cert** and confirm:
   - Subject CN matches the current `CLEARTAX_PARTNER_CERT_SUBJECT_CN` env.
     ```
     openssl x509 -in new.pem -noout -subject -issuer -dates
     ```
     If the Subject CN changed, coordinate a maintenance window: update the env in Secrets Manager first (force an ECS deploy), then roll the cert. Do NOT let the cert go live before the env moves — the guard will 403 every request in the interim.
   - Issuer CN is unchanged. If the Issuer CN changed (ClearTax rotated their CA), update `CLEARTAX_PARTNER_ISSUER_CN` in Secrets Manager BEFORE updating the trust store, in the same way.
   - `notAfter` is at least 60 days out.
3. **Update the ALB trust store bundle.** Upload the new CA PEM (or combined bundle with both old and new CAs during the overlap window) to the S3 object named in `aws_lb_trust_store.cleartax`, then:
   ```
   aws elbv2 modify-trust-store \
     --trust-store-arn <arn> \
     --ca-certificates-bundle-s3-bucket <bucket> \
     --ca-certificates-bundle-s3-key cleartax-ops-ca.pem
   ```
   The ALB picks up the new bundle within ~1 minute. No app restart is needed; the guard reads env at request time and the Cognito verifier is unchanged.
4. **Verify end-to-end with ClearTax.** Ask them to run their smoke test against `GET /partners/cleartax/firms/<firm>/audit?limit=1` from the new cert. Expect a 200. Confirm in the API logs that the request landed (no 401/403).
5. **Remove the old CA from the bundle** at least 7 days after ClearTax confirms every one of their workloads is on the new cert. Keep the overlap short — a stale CA in the trust store is a latent threat.

## Incident playbook — 403 spike on the partner route

A sudden rise in `faatora_http_requests_total{route="partners/cleartax/firms/:firmId/audit", status="403"}` means one of the three guard checks started failing. Walk them in order of likelihood:

1. **(a) Cert expiry or Subject/Issuer CN drift.**
   - Check the active cert's `notAfter` by asking ClearTax (or pulling from the ALB access logs' `client_cert_serial`). Within 14 days of expiry is the warning line; the guard rejects at `notAfter <= now()`.
   - Confirm `CLEARTAX_PARTNER_CERT_SUBJECT_CN` and `CLEARTAX_PARTNER_ISSUER_CN` in the live task env match what the inbound cert actually presents:
     ```
     aws ecs describe-tasks --tasks <task-arn> --query 'tasks[0].containers[0].environment'
     ```
   - If a rotation was in flight, this is almost certainly a mid-rotation env mismatch — restore the env to the pre-rotation value or roll the ECS service to pick up the new one.
2. **(b) Allowlist drift.**
   - Confirm `CLEARTAX_PARTNER_IP_ALLOWLIST` still covers ClearTax's current egress range. ClearTax announces IP changes in their partner portal; a NAT change on their side is the second most common cause.
   - A blank allowlist is **block all**. If Secrets Manager returned an empty string from a mis-key, every request 403s — check for that first.
3. **(c) Role claim change on their JWT.**
   - Decode the token from a failing request (the API logs the token id, not the token itself — pull one from ClearTax). Confirm `custom:role` (or `role`) is still `clearance-partner`. A Cognito user-pool migration on their side can silently drop custom attributes.
   - If the role claim is missing or spelled differently, do NOT loosen the guard — require ClearTax to fix their token issuer. Loosening this check is a hole across every firm.

If none of (a)-(c) matches, the issue is likely the ALB trust store (bad bundle upload, S3 permission change) or a Cognito outage; the latter would also show up in the firm-console surface and in Cognito's own health page.

## Observability

Alert rules worth having (dashboard: `cleartax-partner`):

- `faatora_http_requests_total{route="partners/cleartax/firms/:firmId/audit", status=~"4.."} > 0.1/s for 5m` — any sustained non-2xx on this route.
- `faatora_http_requests_total{route=".../cleartax/...", status="503"}` **anything above 0** — the guard is reporting the env is missing. P0.
- A daily job that curls `openssl s_client -connect api.faatora.om:443` from the ClearTax CI check and alerts when the client cert is within 30 days of `notAfter`.

## Related

- `apps/api/src/auth/cleartax-partner.guard.ts` — the guard itself.
- `apps/api/src/modules/audit/audit.controller.ts` — the route handler.
- `docs/runbooks/signing-key-rotation.md` — similar operational cadence for signing keys.
