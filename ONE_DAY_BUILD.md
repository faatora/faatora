# Fawtara — one-day build summary

Built 2026-10-17 by 20 parallel subagents + 1 integration fixup pass, across four waves on disjoint directory scopes, against a verified-green EP1–EP3 baseline.

## What's in this archive

**Verified green on this machine**:
- `pnpm lint` — ESLint + Prettier clean across every file
- `pnpm typecheck` — all four workspace projects (shared, compliance, web, api)
- `pnpm db:migrate` — 11 migrations applied cleanly against Postgres 16
- `pnpm test` — **197 tests pass**: 85 in `@fawtara/compliance`, 112 in `@fawtara/api`
- `pnpm build` — all four projects build

## What was built

**Compliance core (`packages/compliance`):** regime-agnostic canonical → EN 16931 semantic (BT-numbered) → PINT-OM specialization → UBL 2.1 serializer with deterministic byte output, plus a four-stage validation pipeline (zod canonical → VAT math → XSD-lite → Schematron-lite with 18 named rules) gated by a 15-fixture golden corpus. **85 tests.**

**API (`apps/api`):** NestJS with Postgres RLS, Cognito auth, and these modules:
- **Tenancy & auth** — tenants/users/memberships with FORCE RLS; TenantGuard + CurrentUser; `/api/me`
- **Invoices & parties** — DRAFT→VALIDATED via the Pipeline validator (not Noop); server-side VAT math in integer baisa
- **Signing** — SIGNER port with env-keyed factory (LocalSigner in dev, KmsSigner refusal in prod); rebuilds UBL server-side; emits sha256, signature, QR, PDF (A4, pdfkit, supplier/buyer blocks, line table, VAT breakdown, totals, QR embedded, document UUID footer — PDF 1.7, not PDF/A-3 yet; see docs/runbooks/pdfa3-upgrade.md); `signed_documents` with FORCE RLS
- **Clearance** — transactional outbox, idempotency on document_uuid, StateMachine class, circuit breaker (3 failures / 60s), @Cron 10s drain, HMAC-authenticated callback with tenant-scoped lookup, stub ASP for dev
- **Archive** — filesystem backend with mode-0o400 immutability + S3 Object Lock stub; per-tenant hash-chain (sha256 with pipe separator); `verifyChain` detects tamper; 10-year `retention_until`; auto-advances CLEARED→ARCHIVED
- **Leads** — public no-auth endpoint with 10-rule readiness scoring and deadline differentiation (2027-04-01 for >5M, 2027-10-01 otherwise)
- **POS** — products catalog, race-free sale number allocation, B2C 24h batching, Z-report
- **Bookkeeping** — 22-account Omani SME CoA, journals with balance guard, trial balance, P&L, balance sheet, VAT return
- **Imports** — CSV, Excel, Tally XML parsers with row-level error reporting
- **Billing + reseller** — basic/pro plans seeded, subscriptions, usage metering, billing invoices, 20% commission accrual to accountant firms
- **Accountant console** — dual-guard architecture (TenantGuard for tenant-scoped, AccountantAuthGuard for cross-tenant), consolidated KPIs run sequentially per tenant to protect the pool
- **Observability** — 10 Prometheus metrics, HTTP middleware tagged by tenant_id, 60s canary validating the compliance core, 15s queue-depth sampler, LogAlertSink + webhook stub

**Web (`apps/web`):** React/Vite with i18next + Tailwind, DirectionProvider flipping `dir="rtl"` on `<html>`, LanguageToggle, 100% logical properties (no `pl-*`/`ml-*`/`text-left` anywhere). Pages: landing (`#`), readiness checker (`#checker`), POS (`#pos`), accountant console (`#accountant`). English + Arabic translations, 120 keys each.

**Infra (`infra`):** Terraform skeleton with 7 modules — network, database (RDS Postgres Multi-AZ), auth (Cognito), kms (signing + data), queue (SQS + DLQ), archive (S3 Object Lock + KMS, 10-year COMPLIANCE retention), compute (ECS Fargate + ALB). All gated behind `var.enable_infra = false` so merging provisions nothing.

**CI (`.github/workflows`):** `ci.yml` with Postgres 16 service runs lint/typecheck/migrate/test/build; `infra.yml` runs terraform fmt+validate+plan via GitHub OIDC into AWS.

## What was reviewed

Four parallel reviewers wrote the audits in `docs/reviews/`:
- `architecture.md` — 5 BLOCKERs (3 critical, 2 follow-up material), 10 follow-ups, 5 cosmetic
- `security.md` — 3 CRITICAL, 4 HIGH, 6 MEDIUM, 5 LOW
- `tests.md` — 38 uncovered service methods identified; 15 concrete gap recommendations
- `i18n-a11y.md` — 3 HIGH, 8 MEDIUM, 5 LOW, 2 cosmetic

The 3 CRITICAL security findings and the 2 critical architecture BLOCKERs were resolved in a Wave 5 fixup pass. Verdict after fixup: **Dev-ready. Not Pre-prod-ready until the remaining HIGH / MEDIUM findings in the review docs are closed and a real ASP contract + Cognito-in-GCC-region + KMS key provisioning are in place.**

## Known gaps still open (what wasn't shipped)

Deliberate deferrals, each a line item in the review docs:
- Real ASP integration (StubAspProvider ships; swap at `TRANSMISSION_PROVIDER` useClass)
- Real KMS signing (KmsSigner is a throwing stub; swap in the factory)
- Real PDF/A-3 rendering (current renderer is a minimal valid-syntax stub)
- Full Tally bridge for live on-prem Tally instances (parser handles the common XML export shape)
- Thawani / Stripe wiring (PaymentProvider port with StubPaymentProvider ships)
- End-to-end HTTP integration tests (unit + service-level integration ship; supertest-driven HTTP tests are a tracked gap in `docs/reviews/tests.md`)
- Live AWS infra provisioned (modules exist; `enable_infra` is false)
- i18n/a11y HIGH findings in A20's review not yet patched

## What you own next

The ADR-0001, ADR-0002, SECURITY.md, docs/sla.md, and the 5 runbooks under docs/runbooks/ are the operational contract this build commits to. Your three immediate external actions (unchanged from earlier drafts): send the three ASP outreach emails, recreate the Cognito pool in me-south-1 or me-central-1, request the OTA PINT-OM data dictionary from whichever ASP replies first.
