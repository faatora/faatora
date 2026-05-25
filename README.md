<<<<<<< HEAD
# fawtara
E-invoicing
=======
# Fawtara

Multi-tenant Oman e-invoicing SaaS (OTA Fawtara / Peppol PINT-OM compliant).
Monorepo: NestJS API + React web + a pure compliance core, on AWS.

## Layout

- `apps/api` — NestJS backend (TypeScript). Structured logging, env validation, Drizzle + RLS-ready tenant transactions, health endpoint.
- `apps/web` — React + Vite shell (smoke-tests the API).
- `packages/compliance` — EP4: pure PINT-OM / UBL 2.1 core (placeholder).
- `packages/shared` — cross-cutting types.
- `infra` — Terraform (IaC). State backend + workload region are independent.
- `.github/workflows` — `ci.yml` (lint/typecheck/test/build) and `infra.yml` (Terraform via AWS OIDC).

## Run locally

Requires Node >= 20 and Docker.

```bash
corepack enable                       # gives pnpm
cp .env.example apps/api/.env         # adjust if needed
docker compose up -d                  # local Postgres on :5432
pnpm install
pnpm db:migrate                       # applies migrations
pnpm dev:api                          # API on :3000  -> GET /api/health
pnpm dev:web                          # web on :5173
```

## CI/CD prerequisites (set once)

- GitHub repo secret `AWS_DEPLOY_ROLE_ARN` = the OIDC deploy role ARN.
- (Optional) repo variables `AWS_REGION` (workload region, default me-south-1) and
  `TF_STATE_REGION` (state-bucket region, default us-east-1).

## Status

EP1 — Platform foundation & CI/CD. Tenant tables, RLS, and Cognito auth land in EP2.
>>>>>>> EP1: platform foundation & CI/CD scaffold
