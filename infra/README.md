# infra/

Terraform for the Faatora platform. One root module, two environments.

## Layout

```
infra/
  main.tf, variables.tf, providers.tf, outputs.tf   # root module
  modules/                                           # reusable modules
    network/   compute/   database/   auth/
    queue/     kms/       archive/
  environments/
    staging.tfvars            production.tfvars
    staging.backend.hcl       production.backend.hcl
```

## Environment separation pattern

**tfvars + per-env backend config.** We considered Terraform workspaces
and per-env root modules; tfvars won because:

- Root module stays identical for every environment — no copy-paste drift.
- State files are fully separate (`staging/terraform.tfstate` vs
  `production/terraform.tfstate` under the same bucket), so there is no
  chance of a `terraform workspace select` mistake destroying prod.
- CI already passes `-var` flags explicitly, so switching to
  `-var-file=` is one-line per workflow.

Every environment has three sibling files under `environments/`:

| File                       | What it holds                                     |
| -------------------------- | ------------------------------------------------- |
| `<env>.tfvars`             | Variable values (region, VPC CIDR, AZ count, …).  |
| `<env>.backend.hcl`        | S3 bucket, state key, state region, lock table.   |

## Running Terraform

Always pick an environment up-front. There is no default: `aws_region`
has no `default`, so an unqualified `terraform plan` fails fast rather
than touching the wrong region.

### Staging (us-east-1)

```bash
cd infra
terraform init -reconfigure \
  -backend-config=environments/staging.backend.hcl

terraform plan -var-file=environments/staging.tfvars -out=tfplan.staging
terraform apply tfplan.staging
```

### Production (eu-central-1 / Frankfurt)

```bash
cd infra
terraform init -reconfigure \
  -backend-config=environments/production.backend.hcl

terraform plan -var-file=environments/production.tfvars -out=tfplan.production
terraform apply tfplan.production
```

`-reconfigure` is what flips the backend between environments; `terraform
init` without it reuses the previously-initialized backend and would
plan staging against production state (or vice versa).

## State backend

The state bucket `faatora-tfstate` and the lock table `fawtara-tflock`
both live in `us-east-1` — including for the eu-central-1 production
workload. S3 state is small, region-independent in effect, and keeping
one bucket means one KMS/replication/versioning policy to audit.

## What NOT to do

- Do not add an `aws_region` default. Every caller must pass it.
- Do not run `terraform workspace new`. We don't use workspaces.
- Do not share tfvars between environments; each one is authoritative
  for its environment's values.
- Do not `terraform init` without `-reconfigure` when switching env.

See [MIGRATION-TO-EU-CENTRAL-1.md](./MIGRATION-TO-EU-CENTRAL-1.md) for
the first-time production bring-up checklist.
