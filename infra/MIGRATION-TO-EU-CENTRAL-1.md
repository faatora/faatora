# Migration runbook: bring up production in eu-central-1 (Frankfurt)

Owner: Ahmed. This is a one-shot runbook for the **first-time** production
bring-up. Production is greenfield — there is no existing production
data to preserve, so a failed step is recoverable with
`terraform destroy -var-file=environments/production.tfvars` and a retry.

Staging stays in us-east-1 **forever**. Nothing in this runbook touches
staging; if a step seems to, stop and read it again.

## Why eu-central-1

Production holds e-invoicing data for OMA/OET filers and needs to clear
both Oman's **PDPL** personal-data residency expectations and **GDPR**
Article 44–50 for any EU accountant customer. Frankfurt is the closest
AWS region that satisfies both without requiring a BAA/standard
contractual clause chain for outbound transfers.

Staging in us-east-1 is fine because it never holds real customer data.

---

## Prerequisites

Before anything on this runbook runs:

1. **Opt into eu-central-1 in AWS billing.** eu-central-1 is a
   standard (non-opt-in) region, so there is normally nothing to click
   — but confirm in the billing console that the account has no
   region-specific service controls that would block it. For a
   greenfield account, `aws ec2 describe-regions --region-names eu-central-1`
   should return `OptInStatus: opt-in-not-required`.
2. **Confirm no Service Control Policy restrictions.** If the account is
   in an AWS Organizations OU, confirm the SCP attached at the OU/root
   level does **not** carry a `aws:RequestedRegion` deny with
   eu-central-1 in it. From the management account:
   `aws organizations list-policies-for-target --target-id <account-id> --filter SERVICE_CONTROL_POLICY`
   and inspect each policy document.
3. **Verify the IAM deploy role has eu-central-1 in its trust/permission
   boundary.** The role `arn:aws:iam::058264142993:role/fawtara-github-deploy`
   used by GitHub Actions must be able to call AWS APIs in
   eu-central-1. If a permission boundary restricts it by region, widen
   the boundary before proceeding.
4. **Pick a maintenance window.** The first apply takes ~20–30 minutes
   (RDS creation dominates). Any later rollback (`terraform destroy`)
   takes another ~15 minutes.

---

## Step 1 — Provision the new production stack

No data migration. First apply is clean.

```bash
cd infra
terraform init -reconfigure \
  -backend-config=environments/production.backend.hcl

terraform plan \
  -var-file=environments/production.tfvars \
  -out=tfplan.production

# Review tfplan.production carefully. In particular confirm:
#   - VPC CIDR is 10.21.0.0/16 (NOT 10.20.x, which is staging).
#   - Region on every regional resource is eu-central-1.
#   - RDS is in private subnets, publicly_accessible = false,
#     multi_az = true, deletion_protection = true.
#   - S3 archive bucket has object_lock_enabled = true.

terraform apply tfplan.production
```

Or trigger the `Deploy (production)` workflow in GitHub with
`skip_migrations=true`, `skip_smoke_test=true` — that runs the same
plan/apply with the two human-gate reviews. The workflow is
`workflow_dispatch` only, so you must click **Run workflow** manually.

**Checkpoint:** `terraform output` should show `alb_dns_name`,
`ecs_cluster_name`, `db_endpoint`, `archive_bucket_id`. All should
contain `production` and/or resolve to eu-central-1 endpoints.

---

## Step 2 — Request an ACM certificate for api.faatora.om

The ALB in eu-central-1 needs a cert in eu-central-1 (ACM is regional;
ALBs cannot use certs from another region). This is **separate from**
the us-east-1 cert the staging ALB uses for its own subdomain.

1. In the AWS Console, switch region to **Europe (Frankfurt)
   eu-central-1**.
2. Certificate Manager → Request → Public certificate.
3. Domain names: `api.faatora.om`. Optionally add `*.faatora.om` as a
   SAN if the frontend will also use it.
4. Validation method: **DNS**.
5. After the request, ACM shows one or more `_<hash>.api.faatora.om
   CNAME <hash>.acm-validations.aws` records. Add these to the
   authoritative DNS for `faatora.om`.
6. Wait for status `Issued` (usually 5–30 minutes after the DNS record
   propagates).

This cert is **not** managed in Terraform yet. A follow-up PR can import
it into the compute module (`aws_lb_listener` with `protocol = "HTTPS"`
and `certificate_arn = aws_acm_certificate.api.arn`), but for the first
cutover the manual request is enough and keeps the Terraform diff small.

---

## Step 3 — DNS cutover plan for `api.faatora.om`

The staging ALB is reached via `api-staging.faatora.om`. Keep it that
way: **do not point `api.faatora.om` at staging.**

Order of operations, after Step 1 + Step 2 are complete:

1. Confirm the production ALB answers on its AWS-assigned DNS name
   (`faatora-production-alb-<hash>.eu-central-1.elb.amazonaws.com`).
   Hit `http://<alb-dns>/api/health` directly; expect 200.
2. Create an **ALIAS A record** (preferred) or CNAME for
   `api.faatora.om` → the production ALB DNS name. Use ALIAS if the
   authoritative DNS provider supports AWS ALIAS targets; otherwise
   CNAME.
3. Set TTL to 60 seconds for the first week so a bad cutover is
   recoverable quickly. Bump back to 300s/3600s once production is
   stable.
4. Wait for propagation (`dig api.faatora.om +short` from a few
   resolvers) before announcing the endpoint to customers.
5. Re-run the production workflow with `skip_smoke_test=false` to
   confirm the ALB health endpoint is reachable.

Rollback at this step: delete the `api.faatora.om` record. Staging is
untouched because it lives on its own subdomain.

---

## Step 4 — Database initial migration

The migrate task definition is already provisioned by Step 1
(`module.compute.migrate_task_definition_arn`). It runs the same
`node-pg-migrate up` command staging uses, inside the production VPC,
against the private RDS instance.

Trigger it via the `Deploy (production)` workflow with
`skip_migrations=false`. The workflow job `migrate`:

1. Reads `cluster`, `task_def`, `container`, `app_sg`, `subnets`,
   `log_group` from Terraform state (eu-central-1 resources).
2. Resolves the DB URL from AWS Secrets Manager
   (`faatora-production-pg`'s MasterUserSecret) on the runner.
3. Invokes `aws ecs run-task` with the URL injected via container
   override. The URL is masked so it never appears in logs.
4. Waits for the task to stop, inspects the exit code, and dumps
   CloudWatch logs on failure.

Checkpoint: in the AWS Console, confirm `pg_migrations` schema exists
in the RDS instance and lists every migration the repo ships. The
staging runs of the same workflow are a good shape reference.

---

## Step 5 — Initial container push to the production ECR

The production ECR repo is in eu-central-1, distinct from the staging
one in us-east-1. The `deploy-image` job of the production workflow:

1. Creates the ECR repository `faatora-api` in eu-central-1 if it
   doesn't already exist (idempotent).
2. Builds the API image from `docker/api.Dockerfile`.
3. Tags it with both `${GITHUB_SHA}` and `production`, and pushes both.
4. Forces a new ECS service deployment and waits for it to stabilise.

The image repository name is the same as staging (`faatora-api`); only
the registry hostname differs (the AWS account ID is the same but the
region segment is eu-central-1). The `:production` tag is new — see
`infra/modules/compute/variables.tf::migrate_image_tag` for how to pin
it in a later change.

---

## Step 6 — Smoke tests against the production endpoint

Run with `skip_smoke_test=false`. The workflow polls
`http://${ALB_DNS}/api/health` for up to 5 minutes. For a thorough
check, also hit from a human terminal:

```bash
ALB=$(aws elbv2 describe-load-balancers \
  --names faatora-production-alb \
  --region eu-central-1 \
  --query 'LoadBalancers[0].DNSName' --output text)
curl -sS "http://${ALB}/api/health"
curl -sS "http://${ALB}/api/"           # root — expect routing headers
```

Once the api.faatora.om DNS record from Step 3 is live:

```bash
curl -sS "https://api.faatora.om/api/health"
```

(Will only work over HTTPS after the HTTPS listener is wired up with
the ACM cert from Step 2 — a follow-up PR.)

---

## Step 7 — Post-deploy verification

Three invariants to tick off before announcing the environment live:

1. **ECS tasks run in all 3 AZs of eu-central-1.**
   ```bash
   aws ecs list-tasks --cluster faatora-production-cluster \
     --service-name faatora-production-app \
     --region eu-central-1 --query 'taskArns' --output text | \
   xargs -n1 aws ecs describe-tasks \
     --cluster faatora-production-cluster \
     --region eu-central-1 --tasks | \
   jq -r '.tasks[].attachments[].details[] | select(.name=="subnetId") | .value' | sort -u
   ```
   Should list at least 3 distinct private subnet IDs. If it only
   shows 1–2, bump `desired_count` on the ECS service via Terraform
   (default is 0 in `infra/modules/compute/variables.tf`) and
   re-deploy.
2. **RDS is Multi-AZ.**
   ```bash
   aws rds describe-db-instances \
     --db-instance-identifier faatora-production-pg \
     --region eu-central-1 \
     --query 'DBInstances[0].{MultiAZ:MultiAZ, SubnetGroup:DBSubnetGroup.VpcId, Public:PubliclyAccessible}'
   ```
   Expect `MultiAZ: true`, `Public: false`. `production.tfvars` sets
   `db_multi_az = true` so this is just a confirmation.
3. **S3 Object Lock archive bucket is in eu-central-1.**
   ```bash
   aws s3api get-bucket-location --bucket $(cd infra && terraform output -raw archive_bucket_id)
   ```
   Expect `LocationConstraint: eu-central-1`. If you see `us-east-1`
   or `null` here, the apply ran against the wrong provider region —
   stop and `terraform destroy` immediately before anything writes to
   the bucket (object lock would make a wrong-region bucket
   effectively undeletable for 10 years).

---

## Rollback plan

Production is greenfield, so rollback is `terraform destroy`:

```bash
cd infra
terraform init -reconfigure \
  -backend-config=environments/production.backend.hcl
terraform destroy -var-file=environments/production.tfvars
```

Blockers you will hit, in order:

1. **RDS deletion protection.** Set `deletion_protection = false` in a
   PR against `modules/database/variables.tf` (or override at the
   root), apply, then destroy.
2. **S3 Object Lock on the archive bucket.** Any object written to
   the bucket is locked for `var.retention_days` days (default 3653 =
   10 years) and cannot be deleted. If Step 1 was apply-only and
   nothing has written to the bucket yet, the empty bucket itself can
   still be deleted. If any object has landed (e.g. a smoke-test
   upload), **the bucket is undeletable until the retention expires**.
   Treat this as the point of no return.
3. **CloudWatch log groups.** Destroy leaves these behind; delete them
   manually or add `force_destroy = true` in a future module.

No customer data exists yet, so there is nothing else to preserve.

---

## What NOT to migrate

Staging stays in us-east-1 **forever**. Do not:

- Change `aws_region` in `environments/staging.tfvars`.
- Re-key the staging Terraform state (`staging/terraform.tfstate`).
- Copy any staging data into eu-central-1 — even test data. The two
  environments must remain fully independent so a staging failure
  can't leak into a production customer's data path.
- Delete the staging VPC CIDR 10.20.0.0/16 or renumber it to overlap
  with production's 10.21.0.0/16.
- Point `api.faatora.om` at the staging ALB at any point.

When in doubt, re-read the `environments/*.tfvars` files — they are
authoritative for each environment's region and CIDR.
