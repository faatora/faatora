# Faatora Architecture Review — End of Wave 3

Reviewer: A17 (architecture)
Scope: everything built in Waves 1-3 (EP1-EP4).
Date: 2026-10-17.

The product's claim is tier-0 OTA e-invoicing for Oman — multi-tenant, 99.95% clearance success, 10-year signed archive. The code backs most of that claim; this review calls out what still has to change before a real ASP is wired in and before the archive SLO leaves the slide deck.

---

## 1. System overview

The service decomposes into three planes.

**The application plane** runs under NestJS 10 behind an ALB. Authentication is Cognito-verified JWTs resolved to a local `users` row; a request becomes "scoped" when `TenantGuard` reads the `x-tenant-id` header, verifies the caller's `memberships` row, and attaches `tenantId` + `role` to the request. Every service that touches tenant data wraps its query inside `withTenant(db, tenantId, tx => ...)`, which opens a Postgres transaction, issues `SELECT set_config('app.tenant_id', $1, true)`, and lets the row-level security policies filter rows below the service layer. The invoicing lifecycle is `DRAFT → VALIDATED → SIGNED → SUBMITTED → CLEARED | REJECTED → ARCHIVED`, with each transition owned by exactly one module and guarded by a shared state-machine assertion. The accountant console is a sibling plane: the same `users` and `memberships` tables, but requests enter via `AccountantAuthGuard`, which does not require `x-tenant-id` because the console works across the firm's book of client tenants.

**The compliance plane** lives in `packages/compliance` and is pure, DB-free, dependency-light. Four layers are stacked. `canonical` is the local shape produced by the API; `semantic/en16931` is the EN 16931 "pay once, specialise many times" middle layer; `pint-om` is the Peppol PINT-OM customisation; `ubl` is the serialiser that fast-xml-parser deterministically turns into bytes the ASP signs over. The `validate/pipeline` entry point threads the four stages: zod canonical shape, VAT-math arithmetic rebuild, UBL XSD-lite structural scan, Schematron-lite business rules (BR-, BR-CO-, BR-S/Z/E-, BR-OM-). A golden corpus of fixtures freezes the behaviour on every PR. The rule-pack version is a string the API persists next to each VALIDATED invoice so a later rule-pack bump is traceable.

**The transmission plane** is the clearance gateway. A signed invoice emits exactly one row into `clearance_outbox` within the same transaction that flips the invoice to `SUBMITTED`, with `document_uuid` as the idempotency key (a UNIQUE constraint turns the insert into a hard idempotency guard). A cron-driven scheduler (`every 10s`) calls `drainOnce`: it reads `(id, tenant_id)` candidate tuples through a superuser pool that bypasses RLS, then processes each row under `withTenant` so every write stays tenant-scoped. The transmission adapter is the `TransmissionProvider` port; a `StubAspProvider` is wired in for Wave 3 and the port is the only contract a production ASP has to satisfy. A per-process circuit breaker trips on three consecutive failures and short-circuits for 60s; while open, the drain still pushes `next_attempt_at` forward so the outbox is never scanned uselessly. Async OTA verdicts arrive at `handleCallback`, which is idempotent against the invoice's current state.

**The 10 database tables that matter** are `tenants` + `memberships` (identity), `parties` + `invoices` + `invoice_lines` (invoicing), `signed_documents` (crypto artefacts), `clearance_outbox` + `clearance_events` + `clearance_dlq` (transmission), and `archive_records` (10-year WORM store). Every tenant-scoped table has `ENABLE ROW LEVEL SECURITY` with `FORCE`, a non-BYPASSRLS app role (`faatora_app`), and a USING + WITH CHECK policy keyed on `current_setting('app.tenant_id', true)::uuid`. The `signed_documents` row is the input to the archive hash-chain: each `archive_records` row stores `sha256`, `prev_sha256` of the previous row for the same tenant, and `chain_hash = sha256(prev ?? "" || "|" || sha256)` so tampering surfaces during `verifyChain`.

**Deployment surface** is Terraform under `infra/`, gated by `enable_infra = false` today. Seven modules — `network` (VPC + ALB SG + app SG + db SG), `kms` (asymmetric signing key + data key for the archive bucket), `auth` (Cognito user pool), `queue` (SQS clearance + DLQ with KMS encryption and a redrive policy), `database` (Postgres 16 with a parameter group logging DDL and slow queries), `archive` (S3 bucket with Object Lock + versioning + lifecycle, intended for 10-year compliance mode), and `compute` (ALB + target group + task definition). The region defaults to `me-south-1` (Bahrain), which is the OTA-adjacent data residency choice.

---

## 2. Design decisions worth preserving

- **Row-level security with `FORCE` on every tenant table, run under a non-BYPASSRLS app role.** Puts tenant isolation at the lowest trust boundary and makes an un-scoped query return zero rows rather than leak.
- **Transactional outbox with `document_uuid` as the idempotency key.** The unique-constraint-plus-ON-CONFLICT-DO-NOTHING pattern means a retry of `POST /invoices/:id/submit` is a lookup, not a double send.
- **Dedicated `StateMachine` class with a per-transition actor allowlist.** DRAFT→VALIDATED, VALIDATED→SIGNED, SIGNED→SUBMITTED, SUBMITTED→CLEARED|REJECTED are declared in one file, asserted at the service seam, and journalled with `(from, to, actor)` into `clearance_events` so an auditor can rebuild any invoice's timeline from append-only data.
- **Signing keys never in app memory — SIGNER port abstracts KMS vs local.** `LocalSigner` is the dev stub (RSA-SHA256 forge keypair in `/tmp`), `KmsSigner` is the production class, swap is one line in `signing.module.ts`.
- **EN 16931 semantic middle layer so UAE/KSA sibling packs are additive.** The canonical→semantic→PINT-OM→UBL stack means a SAU or UAE regulator pack lives alongside PINT-OM without re-plumbing the API's data types.
- **Golden corpus gating the compliance core on every PR.** The pipeline is pure; snapshot-style fixtures catch an accidental drift in rule semantics before it merges.
- **Per-tenant archive hash chain with a `|` separator.** Each tenant's chain is independent (a compromise in one tenant doesn't invalidate another's), and the explicit separator means a null-prev row is distinguishable from a prev whose hex happens to prefix the current `sha256`.
- **Circuit breaker that short-circuits but keeps the outbox growing.** `drainOnce` nudges `next_attempt_at` forward while the breaker is open rather than piling rows at `now()`; when the ASP recovers the drain quietly resumes.
- **Metrics tagged by `tenant_id` for per-customer SLO drill-down.** `faatora_invoice_issued_total`, `faatora_clearance_submissions_total`, `faatora_signing_total` all carry `tenant_id`. Cardinality is bounded by the known tenant list; latency and queue-depth histograms stay tenant-free to keep cardinality cheap.

---

## 3. Design decisions that need revisiting

### BLOCKER — must fix before production ASP wiring

**B1. `ArchiveService` is never called automatically after `CLEARED`.** `apps/api/src/modules/clearance/clearance-gateway.service.ts:319-349` (`applyCleared`) and `:454-472` (`handleCallback` cleared branch) stop at updating `invoices.status = 'CLEARED'` and inserting a `clearance_events` row. The declared state machine says `CLEARED → ARCHIVED`, but no code path drives it; `archiveInvoice` is only invoked from `POST /archive/invoices/:id` by a human. The 10-year archive SLO is thereby conditional on manual action. **Fix:** at the end of `applyCleared` and `handleCallback(cleared)`, enqueue an archive job (or call `archive.archiveInvoice` under its own retry policy) and journal the `CLEARED → ARCHIVED` transition. Alternatively, add an `archive_outbox` mirror of the clearance outbox so the archive step has its own retries without re-opening the clearance tx.

**B2. `PipelineComplianceValidator` injects placeholder party data.** `apps/api/src/modules/invoices/compliance.pipeline.ts:108-115` hands the compliance core `supplier.name = "party:<uuid>"`, hard-coded `country: 'OM'`, no VATIN. This silences every rule that needs real party fields: BR-06 (supplier name presence) is trivially satisfied, BR-OM-001 (VATIN format) never fires because `supplier.bt31_vatIdentifier` is undefined, BR-OM-002 (non-OMR warning) still runs but is useless without the buyer's real country. Production invoices that pass `issue()` can be rejected by the OTA on the first real-party ground. **Fix:** resolve the two `parties` rows inside `issue()`'s transaction and pass them to the port. The port can grow a `warnings` channel at the same time (see F1).

**B3. `handleCallback` resolves invoices by `asp_reference` alone across all tenants with no uniqueness.** `apps/api/src/modules/clearance/clearance-gateway.service.ts:597-607` runs `SELECT id, tenant_id FROM invoices WHERE asp_reference = $1 LIMIT 1` through the RLS-bypassing sweep pool. The migration adds `asp_reference` as a plain nullable text column with no index and no uniqueness (`apps/api/migrations/1710001000000_clearance.cjs:76-80`). A real ASP that uses structured, short-form references (common in the sector — `ASP-YYYYMMDD-NNNN`) can produce the same string for two tenants, and `LIMIT 1` would then route a callback to the wrong tenant's invoice. The HTTP callback endpoint relies entirely on transport-level webhook auth for safety. **Fix:** either add a partial unique index on `invoices.asp_reference WHERE asp_reference IS NOT NULL`, or match callbacks against `clearance_outbox.idempotency_key` (which is tenant-safe because the invoice `document_uuid` is a v4 UUID). Preferably both.

**B4. `drainOnce` fails silently when `MIGRATION_DATABASE_URL` is unset.** `clearance-gateway.service.ts:574-595` constructs the sweep pool from `env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL`. In production the fallback is the `faatora_app` role, which is `FORCE ROW LEVEL SECURITY`; without `app.tenant_id` set, `SELECT id, tenant_id FROM clearance_outbox` returns zero rows. The scheduler keeps running, logs nothing, dashboards look green, and every signed invoice piles up as SUBMITTED forever. **Fix:** on `onApplicationBootstrap`, refuse to start the drain when `NODE_ENV=production` and `MIGRATION_DATABASE_URL` is unset; mirror the warn the queue-depth sampler already emits (`queue-depth-sampler.service.ts:41-46`) and promote it to an error. Add a Prometheus gauge for "ticks since last candidate seen" so an idle drain surfaces on the dashboard rather than through user complaints.

**B5. `payments.service.create` and `supplier-bills.service.create` do not verify that the referenced `partyId` / `invoiceId` / `billId` belong to the current tenant.** `payments.service.ts:11-29` and `supplier-bills.service.ts:9-32` insert the row with `tenantId` taken from the auth context (so the WITH CHECK on the `payments` policy passes trivially), but Postgres's FK integrity triggers run with elevated privilege and are not subject to RLS, so a crafted DTO can attach a payment to another tenant's party, invoice, or bill. A14 flagged this in the module review. **Fix:** adopt the pattern in `invoices.service.create` (`invoices.service.ts:30-41`): `SELECT id FROM parties WHERE id IN (...)` under `withTenant` and reject if any ID is invisible. Same for `invoiceId` and `billId`.

### FOLLOW-UP — must fix in Wave 4 or v1.1

**F1. `ComplianceResult` has no `warnings` channel.** `compliance.port.ts:3-7` only carries `errors`; `pipeline.ts:116-121` happily computes warnings (BR-OM-001, BR-OM-002) and `compliance.pipeline.ts:138-145` drops them on the floor on the `ok` branch. Operators lose a useful "something is off" signal that regulators often convert from warning to error in later rule-pack versions. **Fix:** extend `ComplianceResult` with `warnings?: string[]` and surface them in the invoice response and in a `faatora_compliance_warning_total{rule}` counter.

**F2. `StubAspProvider`'s idempotency cache is module-scoped and in-memory.** Fine for Wave 3 integration tests. Across multiple replicas with a real ASP that cares about replay windows this becomes a per-replica cache. Not applicable while the stub is the provider; promote to a BLOCKER when the real adapter lands if the ASP SLA doesn't itself guarantee server-side idempotency.

**F3. `TransmissionCircuitBreaker` is per-process.** `circuit-breaker.ts:21-30` — a replica that happens to see 3 flaky calls in a row trips while its siblings keep hammering the ASP. For Wave 4, back the breaker with a shared counter (Redis / a small `transmission_breaker` row with a last-updated timestamp) or at minimum expose each replica's breaker state as a gauge so you can see fleet-wide health.

**F4. `signing.module.ts` hard-wires `LocalSigner` with no env-driven switch.** `signing.module.ts:9` — a prod deploy that forgets to edit this file silently uses the dev signer that reads/writes the key at `/tmp/faatora-dev-signing.pem`. **Fix:** switch via `SIGNER_BACKEND` env (`local` | `kms`) with a strict `production` guard that forces `kms` and fails boot otherwise.

**F5. `archive.module.ts` hard-wires `FilesystemStorage` in the same way.** `archive.module.ts:19` — same pattern, same risk. S3 storage is implemented but not wired; without an env switch the Object Lock bucket in `infra/modules/archive` is never written to.

**F6. Archive hash-chain read of `prev_sha256` is racy.** `archive.service.ts:108-115` does `SELECT ... ORDER BY archived_at DESC LIMIT 1` inside the write transaction. Two concurrent `archiveInvoice` calls for the same tenant can both see the same previous row, both compute `chain_hash` against it, and commit — leaving two rows with identical `prev_sha256` and a chain that `verifyChain` later rejects. **Fix:** serialise per-tenant archive writes with `SELECT ... FOR UPDATE` on a tenant chain-head row, or pessimistic-lock via `pg_advisory_xact_lock(hashtext(tenant_id))` at the top of `archiveInvoice`.

**F7. `/metrics` is unauthenticated and the restriction is documented, not implemented.** `README.md:12` says "restrict `/metrics` at the network layer" but no Terraform module provisions an SG/listener rule. **Fix:** add a Prometheus-scraper SG and an ALB listener rule in `infra/modules/compute/main.tf`.

**F8. `invoices.canonicalPayload` and `invoices.rulePackVersion` are schema'd but never written.** `invoices.service.issue` (`invoices.service.ts:119-132`) stores `rulePackVersion` but not `canonicalPayload`. Auditor replay of what the compliance core actually ran against is the point of those columns; without the payload the rule-pack version is a half-trail.

**F9. Queue-depth gauge is global, not per-tenant.** `queue-depth-sampler.service.ts:72-91` emits `clearance_queue_depth{status}` with no `tenant_id`. The SLA page promises per-tenant dashboards. **Fix:** group the sampling query by `(status, tenant_id)` with a cardinality cap (top-N or trailing-30-day-active tenants only).

**F10. `StubAspProvider`'s async-mode `setTimeout` is unreffed.** `stub-asp.ts:72-80` — on a process shutdown mid-sleep the callback fires against a disposed sink. Belt-and-braces: track the handle in a Set, clear on `onModuleDestroy`.

### COSMETIC — nice to have

**C1.** Pino `redact` list only covers `req.headers.authorization` (`app.module.ts:38`). Add `req.headers.cookie`, `req.body.password` just so a careless controller doesn't light up a log line with a shared secret.

**C2.** `tenants` RLS policy is `USING` only (no `WITH CHECK`) — `migrations/1710000100000_tenancy.cjs`. INSERTs into `tenants` aren't guarded; today only an admin path writes there, but defence in depth is cheap.

**C3.** `withTenant` throws an opaque `invalid input syntax for type uuid: ""` when the caller passes an empty tenant id. One-line guard upstream would give a clearer 400.

**C4.** `pos_number_sequences` has no `updated_at` — a POS numbering bug would be hard to attribute post-hoc.

**C5.** `users` table has no RLS. Not currently a leak path (lookup by `cognito_sub` from a verified JWT), but noteworthy for anyone extending the auth layer.

---

## 4. Scalability and failure modes

Honest first-breakage analysis at the three load points, with the smallest-cost mitigation per cell.

| Tier | 1k TPS sustained | 10 tenants (today's shape) | 10M stored invoices |
| --- | --- | --- | --- |
| **API / Nest** | Node single-process event loop saturates around 2-3k RPS on a 2 vCPU task; `TenantGuard`'s per-request `withTenant` → `users` + `memberships` SELECTs are two round-trips. Mitigation: cache the `(cognito_sub, tenant_id) → membership` lookup for 60 s with an invalidation hook on `memberships` writes. | Fine — 10 tenants is one SG column of cardinality on the metrics side. | Pagination on `invoices.list` is currently absent (`invoices.service.list` returns everything ordered by `createdAt`). Mitigation: add keyset pagination with `cursor + limit`; retrofit the controller before stored invoices cross six figures. |
| **Postgres** | `clearance_outbox` writes are the hottest table; the `(status, next_attempt_at)` index serves the drain but every `issue → sign → submit` touches 4 tables under one tx. At 1k TPS the primary becomes the limit, not the API. Mitigation: raise `max_connections` modestly, enable `pg_stat_statements`, consider logical replicas for the archive read-side. | Fine — 10 small schemas, RLS filters are B-tree index lookups. | Hash-chain `verifyChain` is O(N) over a tenant's `archive_records`. For a tenant with 1M rows a full verify is ~30-60 s. Mitigation: cache a "verified up to row id X" marker per tenant and only re-verify the suffix. |
| **Compliance core** | Pure functions, no I/O; the pipeline is roughly 500 µs on a mid-tier CPU for a 5-line invoice. 1k TPS is 500 ms of CPU/second — one vCPU. Mitigation: nothing yet; profile when the rule pack doubles. | Fine. | Fine — stateless. |
| **Clearance pipeline** | Drain is a single scheduler fire every 10 s with `LIMIT 50`. At 1k TPS of new signatures the outbox grows at 500/tick → the drain can't keep up. Mitigation: raise `LIMIT` to 500, add `WHERE … FOR UPDATE SKIP LOCKED` so multiple replicas can drain in parallel, run the drain on its own worker pool. | Fine. | `clearance_events` is append-only and never pruned; 10M invoices × ~5 events each = 50M rows. Partition by month (declarative partitioning), expire operational partitions older than 2 years to glacier-friendly storage. |
| **Archive storage** | Filesystem backend is single-node and single-writer; it falls over at 1k TPS. S3 Object Lock in COMPLIANCE mode handles the write rate but a hot tenant can hit S3 prefix-level limits. Mitigation: production uses S3 (currently un-wired, see F5); prefix with `tenantId/YYYYMM/` as the FS backend already does, which is also a healthy S3 partition key. | Fine. | 10M invoices × ~5 KB signed XML = ~50 GB. Trivial for S3. Lifecycle policy to IA after 90 days + Glacier after 2 years keeps cost sane. |
| **Signing** | `LocalSigner` is in-process RSA — ~2 ms per sign on a 2 vCPU box, so ~500 req/s per task. KMS calls add 20-30 ms of network round-trip, so KMS throughput ceiling becomes the ASP of the signing step; AWS KMS limits are ~500 Sign/s per key by default, shared across the account. Mitigation: request a KMS limit increase ahead of launch; split signing across two keys and round-robin if that's not enough. | Fine. | Not applicable (signing is per-request). |
| **Observability** | `/metrics` endpoint is held in-process; prom-client series grow with `tenant_id`-labelled counters. 10 tenants × ~10 counters × a few labels = ~1 KB/scrape. Fine. | Fine. | A 10-year retention of `/metrics` scrapes is the operator's problem, not the service's. Fine. |

Primary bottleneck summary: at 1k TPS the drain scheduler and the archive storage are the first two tiers to break; at 10M stored invoices the lack of pagination and the `verifyChain` suffix caching are the first two to fix.

---

## 5. Deployment readiness checklist

Grading is against the current `main`.

- **R1. RLS on every tenant-scoped table with `FORCE` and non-BYPASSRLS app role.** — DONE (all 10 tables; see each migration).
- **R2. Transactional outbox + `document_uuid` idempotency.** — DONE (`clearance-gateway.service.ts:80-153`).
- **R3. State-machine assertion before every transition.** — DONE (`state-machine.ts`, called from both branches of the gateway and from the callback).
- **R4. Circuit breaker fronting the ASP.** — DONE for a single process (`circuit-breaker.ts`). FOLLOW-UP (F3) for multi-replica.
- **R5. Archive hash-chain + `verifyChain` endpoint.** — DONE (`archive.service.ts:176-207`). Race hardening still needed (F6).
- **R6. Prometheus `/metrics`, queue-depth sampler, canary.** — DONE (code), IN-PROGRESS (network restriction — F7, dashboards still placeholder in `docs/sla.md`).
- **R7. Signing-key rotation runbook executed end-to-end against KMS.** — IN-PROGRESS (runbook exists at `docs/runbooks/signing-key-rotation.md`; KMS signer not wired — F4).
- **R8. S3 archive wired via Object Lock in compliance mode.** — NOT-STARTED. `S3Storage` class exists, module not switched (F5); Terraform `infra/modules/archive` provisions the bucket but `enable_infra = false`.
- **R9. Real ASP transmission provider in place.** — NOT-STARTED. Stub ships as default (`clearance.module.ts:26`).
- **R10. Archive auto-triggered on `CLEARED`.** — NOT-STARTED (B1).
- **R11. Compliance pipeline receives real party data.** — NOT-STARTED (B2).
- **R12. Callback invoice lookup is tenant-safe.** — NOT-STARTED (B3).
- **R13. `MIGRATION_DATABASE_URL` presence enforced at boot in production.** — NOT-STARTED (B4).
- **R14. `payments` / `supplier-bills` service-layer party-visibility checks.** — NOT-STARTED (B5).
- **R15. Alert webhook wired (`FAATORA_ALERT_WEBHOOK`) and routing to PagerDuty / Opsgenie.** — NOT-STARTED. `WebhookAlertSink` exists; `LogAlertSink` is the DI default (`README.md:37-43`).
- **R16. Terraform `enable_infra = true`, modules applied end-to-end in a staging account.** — NOT-STARTED.

Go-live blockers are R10, R11, R12, R13, R14, R8, R9, R15 — the first five are architectural (BLOCKERs above), the last three are wiring.
