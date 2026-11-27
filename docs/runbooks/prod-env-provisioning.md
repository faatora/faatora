# Production env-var provisioning

**Audience:** release engineer / infra operator.
**When:** before (and after) every production deploy; also the first-run
checklist for the greenfield eu-central-1 stack described in
`infra/MIGRATION-TO-EU-CENTRAL-1.md`.

Every env var the API reads at boot is now either (a) committed to
`infra/environments/{staging,production}.env.json` and applied on the
next deploy, or (b) carried in Secrets Manager with Terraform owning
the resource but **not** the value. This runbook is the shared contract
between the deploy workflow (which does (a) automatically) and the
operator (who does (b) out-of-band).

Related runbooks:

- `docs/runbooks/cleartax-partner-access.md` — mTLS + partner-cert wiring
- `docs/runbooks/password-login.md` — POS login env surface
- `docs/runbooks/accountant-impersonation.md` — `IMPERSONATION_SESSION_TTL_MS`
- `docs/runbooks/signing-key-rotation.md` — `KMS_SIGNING_KEY_ID`

---

## 1. What this PR auto-wires

These values come from `infra/environments/production.env.json` (and the
staging mirror) and are merged into
`containerDefinitions[0].environment[]` and `.secrets[]` by the deploy
workflow's "Register task definition revision …" step. They land on the
next `Deploy (production)` run and every run after it:

| Var | Source | Notes |
|---|---|---|
| `NODE_ENV=production` | literal in overlay | Staging also runs `NODE_ENV=production` so the clearance-stub safety gate refuses to boot. |
| `LOG_LEVEL=info` | literal in overlay | Bump to `debug` by editing the overlay file and merging a PR; no infra change needed. |
| `ARCHIVE_STORAGE_BACKEND=s3` | literal in overlay | Flips the archive package from `local` (dev/CI) to S3 WORM. |
| `ARCHIVE_BUCKET` | `tf:archive_bucket_id` | Resolved from `terraform output archive_bucket_id`. |
| `ARCHIVE_KMS_KEY_ID` | `tf:kms_data_key_alias` | Alias, not raw key id — key rotation under the alias needs no redeploy. |
| `KMS_SIGNING_KEY_ID` | `tf:kms_signing_key_alias` | Same reasoning as above. |
| `AWS_REGION` | literal (`eu-central-1` prod, `me-south-1` staging) | Used by the SDK; task role lives in the same account, so the region is all it needs. |
| `IMPERSONATION_SESSION_TTL_MS=600000` | literal in overlay | 10 minutes. Tune in the overlay if the firms team wants shorter windows. |
| `DATABASE_URL` | assembled by workflow from the RDS master-user secret | The workflow reads the RDS-managed `{"username":…,"password":…}` secret, URL-encodes the password, assembles the full `postgres://` URL, injects it as a plain env var and overrides the overlay placeholder. Values are masked before the next shell line runs, so they never appear in logs. Same pattern the migrate job already uses, now extended to the long-running service. |
| `ALLOW_STUB_ASP_IN_PRODUCTION` | literal `1` on staging; **absent** on production | Opt-in to let `StubAspProvider` boot under `NODE_ENV=production` (PR #29's guard). Staging wires it so the stub can run until the real partner-ASP credentials arrive. Production deliberately leaves it off — `StubAspProvider` refuses to boot, which forces a real `TransmissionProvider` to be wired before the first prod deploy. |
| `COGNITO_CLIENT_SECRET` | `tf:cognito_client_secret_arn` → SM `valueFrom` | Placeholder secret value `PLACEHOLDER_SET_VIA_CONSOLE` until step 1 below is done. |

The three `CLEARTAX_PARTNER_*` vars are present with empty-string values
on purpose — see §2.2.

---

## 2. What the operator must do out-of-band

### 2.1 Cognito app client secret

The Terraform `auth` module creates a Secrets Manager placeholder on
every apply but never writes the real value (the `aws_secretsmanager_secret_version`
resource has `lifecycle { ignore_changes = [secret_string] }`). The
operator writes it once, in the AWS console or via CLI.

Steps:

1. In the Cognito console, open the production user pool
   (`faatora-production-users`) → **App integration** → the
   `faatora-production-web` app client. If the client was created with
   `generate_secret = false` (the default in `modules/auth/main.tf`),
   it has no client secret and server-side flows go without
   `SECRET_HASH`. **Skip the rest of this subsection** — the placeholder
   stays as `PLACEHOLDER_SET_VIA_CONSOLE` and `CognitoAuthService`
   handles the no-secret case.
2. If you have switched (or need to switch) to a client with
   `generate_secret = true` — typically to tighten server-to-Cognito
   calls for the impersonation or POS flows — copy the secret off the
   console once and seal it into Secrets Manager:

   ```bash
   aws secretsmanager put-secret-value \
     --region eu-central-1 \
     --secret-id faatora-production-cognito-client-secret \
     --secret-string "<the actual secret from the Cognito console>"
   ```

3. Force a new ECS service deployment so running tasks pick up the new
   value (ECS resolves `secrets[].valueFrom` at task-start, not
   continuously):

   ```bash
   aws ecs update-service \
     --region eu-central-1 \
     --cluster faatora-production-cluster \
     --service faatora-production-app \
     --force-new-deployment
   ```

### 2.2 ClearTax partner trio (`CLEARTAX_PARTNER_*`)

`ClearTaxPartnerGuard` returns `503 "partner access not configured"`
whenever `CLEARTAX_PARTNER_CERT_SUBJECT_CN` is empty. That's the
fail-safe for the interval between "we have a partner endpoint" and
"we have the right trust anchors". When Hiba Abu Shaqrah at ClearTax
sends the three values:

1. Edit `infra/environments/production.env.json`:

   ```jsonc
   { "name": "CLEARTAX_PARTNER_CERT_SUBJECT_CN", "value": "ClearTax Partner API" },
   { "name": "CLEARTAX_PARTNER_ISSUER_CN",       "value": "ClearTax Ops CA" },
   { "name": "CLEARTAX_PARTNER_IP_ALLOWLIST",    "value": "203.0.113.0/24,198.51.100.0/24" }
   ```

   The `CLEARTAX_PARTNER_IP_ALLOWLIST` value must match
   `cleartax_partner_cidrs` in the Terraform tfvars overlay (step 2.3).

2. Open a PR, get it reviewed, merge to `main`. The next
   `Deploy (production)` run rolls the API onto the new task-def
   revision.

### 2.3 ClearTax CA bundle + mTLS listener

Flipping `enable_cleartax_mtls = true` without the four supporting
inputs will fail `terraform plan` on purpose (see preconditions in
`infra/modules/compute/mtls.tf`). Sequence:

1. Upload the ClearTax ops CA PEM to the designated S3 bucket and key.
   See `docs/runbooks/cleartax-partner-access.md` for bucket-policy
   details (ops-only, SSE-KMS, GetObject restricted to the ALB service
   principal).
2. Mint the ACM cert for the mTLS listener hostname in
   `eu-central-1` and record its ARN.
3. Edit `infra/environments/production.tfvars`:

   ```hcl
   enable_cleartax_mtls         = true
   cleartax_ca_bundle_s3_bucket = "faatora-production-ops-trust"
   cleartax_ca_bundle_s3_key    = "cleartax-ops-ca.pem"
   cleartax_partner_cidrs       = ["203.0.113.0/24", "198.51.100.0/24"]
   alb_cert_arn                 = "arn:aws:acm:eu-central-1:058264142993:certificate/<uuid>"
   ```

4. Open a PR, get it reviewed, merge. The next `Deploy (production)`
   run (plan → apply) provisions `aws_lb_trust_store.cleartax[0]` and
   the mTLS listener.
5. Do step 2.2 (overlay change) in the same window so the app- and
   infra-layer allowlists agree.

### 2.4 Verifying the env surface on a deploy

After a deploy completes:

```bash
# What env vars does the running task see?
aws ecs describe-task-definition \
  --region eu-central-1 \
  --task-definition faatora-production-app \
  --query 'taskDefinition.containerDefinitions[0].{env:environment,secrets:secrets}'
```

Confirm:

- `CLEARTAX_PARTNER_CERT_SUBJECT_CN` is either empty (guard will 503) or
  matches what ClearTax sent.
- `ARCHIVE_BUCKET` and `ARCHIVE_KMS_KEY_ID` both resolved (not blank —
  a blank means the `tf:` output wasn't found and will crash the API's
  archive module at boot).
- `DATABASE_URL.valueFrom` is a Secrets Manager ARN (not empty).

---

## 3. Rotation

### 3.1 Rotating the Cognito client secret

The `CognitoAuthService` reads `COGNITO_CLIENT_SECRET` from `process.env`
at service construction time, which in ECS Fargate means per task (ECS
resolves `secrets[].valueFrom` when the task starts). Rotation steps:

1. Mint a new client secret in the Cognito console. Cognito keeps the
   old one valid during the grace window so there's no auth outage
   between console-switch and ECS redeploy.
2. Write the new secret into Secrets Manager:

   ```bash
   aws secretsmanager put-secret-value \
     --region eu-central-1 \
     --secret-id faatora-production-cognito-client-secret \
     --secret-string "<new secret>"
   ```

3. Force a new ECS deployment so every running task picks up the new
   value on its next restart:

   ```bash
   aws ecs update-service \
     --region eu-central-1 \
     --cluster faatora-production-cluster \
     --service faatora-production-app \
     --force-new-deployment
   aws ecs wait services-stable \
     --region eu-central-1 \
     --cluster faatora-production-cluster \
     --services faatora-production-app
   ```

4. In the Cognito console, revoke the old client secret.

### 3.2 Rolling back an env change

The overlay file lives in git, so every env change is a reviewable PR.
To roll back:

1. `git revert <sha-of-the-env-change-PR>` in a fresh branch.
2. Open a PR against `main`, merge.
3. The next `Deploy (production)` run picks up the old overlay and
   registers a task-def revision with the reverted env surface.

For an emergency (no time to open a PR), re-register the previous
task-def revision directly:

```bash
# Find the revision number you want to roll back to:
aws ecs list-task-definitions \
  --region eu-central-1 \
  --family-prefix faatora-production-app \
  --status ACTIVE \
  --sort DESC | head -20

# Point the service at it:
aws ecs update-service \
  --region eu-central-1 \
  --cluster faatora-production-cluster \
  --service faatora-production-app \
  --task-definition faatora-production-app:<old-revision> \
  --force-new-deployment
```

Follow the direct-console change with a matching git-level revert so the
next deploy doesn't undo the rollback.

---

## 4. `DATABASE_URL` assembly on the runner

The RDS-managed master-user secret holds `{"username":"…","password":"…"}`
as its SecretString — **not** a `postgres://user:pass@host:5432/db` URL.
The API's `env.ts` (`z.string().url()`) rejects the raw JSON blob at
boot, so the deploy workflow assembles the URL on the GitHub runner
before `register-task-definition` fires.

Implementation (see "Register task definition revision …" step in both
`deploy-staging.yml` and `deploy-production.yml`):

1. `aws rds describe-db-instances` → the endpoint DNS address and the
   master-user secret ARN.
2. `aws secretsmanager get-secret-value` on that ARN → `{username, password}`.
3. URL-encode the password with `urllib.parse.quote(..., safe='')`.
4. Assemble `postgres://${user}:${password_enc}@${endpoint}:5432/${db}?uselibpqcompat=true&sslmode=require`.
5. `echo "::add-mask::"` the raw password, the URL-encoded password and
   the assembled URL before any subsequent shell line runs, so none
   land unmasked in the workflow log.
6. `jq` over `containerDefinitions[0].environment[]`, replacing the
   `DATABASE_URL` placeholder the overlay wrote with the assembled URL.

This mirrors the migrate job's long-standing logic for
`MIGRATION_DATABASE_URL`. The staging workflow has been shipping this
pattern since the 2026-11-26 outage fix; the production workflow now
does the same thing before `register-task-definition`.

Rotation: when the RDS master secret rotates (AWS-managed, every 90 days
by default), the next deploy picks up the new password automatically.
No manual step is required. For an **immediate** pickup without waiting
for a deploy, `aws ecs update-service --force-new-deployment` re-runs
the whole register pipeline, including this step.

---

## 5. Why this is laid out the way it is

- **Env ownership stays in the workflow, not Terraform.** The compute
  module's task-def resource has
  `lifecycle { ignore_changes = [container_definitions] }` on purpose:
  every env change should be a git commit against an overlay file,
  reviewable in PR, without touching `terraform apply`'s plan.
- **Terraform owns the Secrets Manager _resource_, operator owns the
  _value_.** This keeps IAM access patterns and naming in-repo
  (reviewable, pre-approved) while keeping cleartext out of git and
  out of state. The `ignore_changes = [secret_string]` block makes
  this safe to re-apply.
- **`tf:` placeholders over literal ARNs.** Writing
  `"valueFrom": "tf:cognito_client_secret_arn"` instead of pasting the
  ARN means the overlay file is identical between environments and
  survives account moves without a text edit.
- **Empty-by-default for partner config.** Empty
  `CLEARTAX_PARTNER_CERT_SUBJECT_CN` trips the
  `ClearTaxPartnerGuard` 503 fail-safe. An empty value in the overlay
  file is louder (and safer) than a missing env var.
