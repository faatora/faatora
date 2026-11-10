# Faatora Security Review — Wave 3

**Reviewer:** A18 (staff-level security review)
**Date:** 2026-10-17
**Scope:** API (`apps/api`), DB schema + migrations, infra Terraform modules (auth, kms, archive), compliance posture for OTA accreditation path.
**Verdict band:** Dev-ready; **NOT Pre-prod-ready without the CRITICAL items below.**

---

## 1. Executive summary

Faatora's RLS-first tenancy model is sound: every tenant-scoped table uses `FORCE ROW LEVEL SECURITY` with symmetric `USING + WITH CHECK` policies, and the application-level `faatora_app` role has no RLS bypass. However, three show-stoppers block pre-production: (a) the `/invoices/:id/sign` endpoint signs **attacker-supplied XML** rather than server-rebuilt UBL, so a tenant clerk can sign a document whose line items, parties, and totals do not match the DB record; (b) `SigningModule` unconditionally binds `LocalSigner` (software RSA key in `/tmp`) with no `NODE_ENV=production` guard; and (c) the clearance callback path (`handleCallback`) has no HMAC/mTLS verification planned yet, and keys the invoice lookup on a bare `asp_reference` string, which permits state-flip injection once an HTTP route is exposed. These are expected Wave-3 gaps but each must be closed before the first production tenant lands.

---

## 2. Trust boundaries

| # | Boundary | Enforcement | Notes |
|---|---|---|---|
| B1 | **Tenant ↔ tenant** | Postgres FORCE RLS keyed on `current_setting('app.tenant_id')` set per-tx by `withTenant()`. | Every tenant-scoped table carries RLS. `faatora_app` role has no `BYPASSRLS`. See SEC-001 for the one deliberate exception. |
| B2 | **Public internet ↔ tenant data** (leads) | `/api/leads` is unauthenticated; `leads` table has no RLS and no tenant linkage. | DTO validation only. See SEC-003. |
| B3 | **Accountant console ↔ tenant data** | `AccountantAuthGuard` resolves user; service layer re-queries `memberships` under each tenant's RLS context for each cross-tenant read. | Correct pattern. `accountant_firms` + `accountant_client_links` tables themselves have NO RLS (SEC-013). |
| B4 | **API ↔ ASP** (clearance) | Outgoing: `TransmissionProvider` port — Wave 3 uses `StubAspProvider` (in-process). Incoming: `handleCallback` has no HTTP route yet. | SEC-002: when the webhook lands it needs HMAC + an ASP-provided nonce. |
| B5 | **App process memory ↔ local signer key** | File at `/tmp/faatora-dev-signing.pem` mode `0o600`; held in-memory as `forge.pki.rsa.PrivateKey`. | SEC-004: `LocalSigner` is bound even in production. |
| B6 | **Archive storage ↔ operators** | Prod: S3 Object Lock COMPLIANCE + KMS SSE + bucket-public-block. Dev: filesystem mode `0o400` + `wx` immutability flag. | SEC-011: `/tmp/faatora-archive` dev default is world-readable to processes with the same UID. |
| B7 | **Migration pool ↔ RLS** | `MIGRATION_DATABASE_URL` is a superuser URL used by `ClearanceGatewayService.sweepCandidates()` for a cross-tenant SELECT (returns only `(id, tenant_id)`), and by `findInvoiceByAspReference()`. | SEC-001: narrow projection is correct, but the fallback to `DATABASE_URL` and lack of a bypass-check sentinel are footguns. |

---

## 3. Findings

### CRITICAL

#### SEC-001 — Sign endpoint signs attacker-controlled XML (invoice tampering)
- **Severity:** CRITICAL
- **Files:**
  - `apps/api/src/modules/signing/signing.controller.ts`
  - `apps/api/src/modules/signing/signing.service.ts`
  - `apps/api/src/modules/signing/dto/sign-invoice.dto.ts`
- **Description:** `POST /invoices/:id/sign` accepts `ublXml` directly from the request body (`SignInvoiceDto { ublXml: string }`). `SigningService.sign()` passes that string straight to the signer and stores it as `signed_documents.signed_xml`; it does NOT rebuild the XML from the DB record. The invoice row is referenced only to assert `status === 'VALIDATED'` and to pull the supplier VATIN for the QR payload. A tenant user (role `clerk` is enough) can submit valid-looking UBL whose amounts, lines, buyer, or supplier differ from what the server stored at validation time. The signed document, QR, and PDF are all generated from the attacker's XML; the clearance outbox then transmits that XML to the ASP/OTA.
- **Exploitability:** Trivially exploitable by any authenticated clerk. Yields a cryptographically signed document whose contents the auditor cannot reconcile with the DB history. In Omani OTA terms, this is an invoice-tampering primitive hidden inside the normal issue flow.
- **Remediation:**
  1. Remove `ublXml` from the DTO. Build the UBL server-side from `invoices` + `invoice_lines` + `parties`, inside the same `withTenant()` tx that reads the invoice.
  2. Pin the UBL to the already-stored `canonical_payload` / `rule_pack_version` to make rebuilding deterministic.
  3. Record a canonical hash of the DB-derived XML and reject at archive time if it diverges.

#### SEC-002 — Local signer unconditionally bound; dev key on disk reachable in prod
- **Severity:** CRITICAL
- **Files:**
  - `apps/api/src/modules/signing/signing.module.ts`
  - `apps/api/src/modules/signing/local-signer.ts`
  - `apps/api/src/modules/signing/kms-signer.ts`
- **Description:** `SigningModule` wires `{ provide: SIGNER, useClass: LocalSigner }` with no `NODE_ENV` guard. `LocalSigner` persists a 2048-bit RSA private key to `/tmp/faatora-dev-signing.pem` on first use, with `0o600`. `KmsSigner` exists but every method throws "Not yet implemented". If a prod deployment ships `signing.module.ts` as-is, every invoice is signed with a software key living in a world-writable directory, which fails any OTA accreditation audit and lets any co-tenant on the host read it.
- **Exploitability:** No exploit required — this is a build-time latent default. The file-mode `0o600` protects only against other UIDs; `/tmp` on shared container runtimes often collapses UIDs. The chain-of-custody for signed invoices then has no HSM root.
- **Remediation:**
  1. In `signing.module.ts`, choose provider by `NODE_ENV`: `useClass: isProd ? KmsSigner : LocalSigner`, and throw at module boot if `isProd && !process.env.FAATORA_SIGNING_KMS_KEY_ID`.
  2. Finish `KmsSigner` wiring against the already-provisioned `aws_kms_key.signing` (RSA_2048 SIGN_VERIFY, `RSASSA_PKCS1_V1_5_SHA_256`).
  3. Move the dev key path to `FAATORA_DEV_SIGNING_PEM` env with a per-worktree default; refuse to write to `/tmp` when `NODE_ENV!==development`.

#### SEC-003 — Clearance callback is replay- and injection-trivial once exposed
- **Severity:** CRITICAL (promoted from HIGH because this will land Wave 3 and the gateway already sinks verdicts)
- **Files:**
  - `apps/api/src/modules/clearance/clearance-gateway.service.ts` (`handleCallback`, `findInvoiceByAspReference`)
  - `apps/api/src/modules/clearance/stub-asp.ts`
- **Description:** `handleCallback` is the sink the real ASP's webhook will call. It locates the invoice by a bare `asp_reference` string via the superuser pool, then flips the state `SUBMITTED → CLEARED | REJECTED`. There is no HMAC check, no mTLS requirement, no nonce, no clock-skew bound. The idempotency guard is `if status in (CLEARED, REJECTED): return`, which protects re-delivery but not forgery. Once a webhook controller is added, any party who can observe or guess an `asp_reference` can push an invoice to CLEARED or REJECTED.
- **Exploitability:** None today (no HTTP route). High on Wave-3 webhook ship.
- **Remediation:**
  1. Require the ASP's signature header; store the ASP's public key / shared secret in SSM Parameter Store and verify before entering `handleCallback`.
  2. Include a monotonic `callbackId` from the ASP, dedupe by `(asp_reference, callbackId)` in a new `clearance_callbacks_seen` table with a unique index.
  3. Allow-list source IPs at the ALB / WAF layer, additionally.

### HIGH

#### SEC-004 — `faatora_app` role password hardcoded in migration
- **Severity:** HIGH
- **File:** `apps/api/migrations/1710000000000_init.cjs`
- **Description:** The role is created with literal `PASSWORD 'faatora_app'`. The sample `.env` reuses it: `DATABASE_URL=postgres://faatora_app:faatora_app@localhost:5432/faatora`. Any environment that forgets to `ALTER ROLE … PASSWORD` post-migrate ships with a known password.
- **Remediation:** Create the role without a password in the migration (`CREATE ROLE faatora_app LOGIN;`) and rotate the password out-of-band in each environment via SSM / RDS-managed-password; fail boot if `DATABASE_URL`'s password equals the role name.

#### SEC-005 — Public leads endpoint has no rate limiting; weak phone validation; PII capture
- **Severity:** HIGH
- **Files:** `apps/api/src/modules/leads/leads.controller.ts`, `apps/api/src/modules/leads/dto/create-lead.dto.ts`, `apps/api/src/app.module.ts`
- **Description:** `POST /api/leads` is unauthenticated and inserts full name, email, phone, revenue band, source IP into `leads`. No `@nestjs/throttler`, no Nest guard, no WAF rule in Terraform. The phone regex `/^\+?968?\s?\d{4}\s?\d{4}$/` makes the `968` optional (because of the trailing `?`), so any 8-digit sequence passes. `req.ip` is read, but Express has no `trust proxy` set, so behind an ALB this logs the ALB IP, not the user's — but still enough rows to cost storage. There is also no CAPTCHA, so a scraper floods leads cheaply. The response includes a verdict object (`ready`, `blockers`, `recommendations`) which the UI renders — if ever reflected inside markup without escaping, blockers like "Current invoicing tool won't produce PINT-OM/UBL 2.1 XML" are server-generated so there is no XSS vector from leads **today**; still, treat the verdict as data not markup.
- **Remediation:**
  1. Add `@nestjs/throttler` with per-IP 10 req/min on `/api/leads`.
  2. Fix the phone regex: `/^\+?968[\s-]?\d{4}[\s-]?\d{4}$/` (country code mandatory, not optional).
  3. Enable Express `trust proxy` from one hop; emit `x-forwarded-for` only if trusted.
  4. Add WAF rate rule as defense in depth; add a `created_at + ip` composite index + hourly backpressure once the first spike arrives.

#### SEC-006 — `MIGRATION_DATABASE_URL` fallback silently defeats RLS
- **Severity:** HIGH
- **File:** `apps/api/src/modules/clearance/clearance-gateway.service.ts` (`getSweepPool`)
- **Description:** `getSweepPool()` falls back to `DATABASE_URL` when `MIGRATION_DATABASE_URL` is unset. In environments where someone one-day grants `BYPASSRLS` to `faatora_app` (not currently done — but there is no CI guard against it), the sweep then runs as the app role AND bypasses RLS. The sweep SELECTs only `(id, tenant_id)` today, but any later schema change that widens the projection would quietly leak across tenants under that fallback.
- **Remediation:**
  1. Boot-time check: refuse to start if `NODE_ENV==='production'` and `MIGRATION_DATABASE_URL` is unset.
  2. Add a CI assertion that `pg_authid.rolbypassrls` is `false` for `faatora_app`.
  3. Narrow the sweep's SQL to an explicit `SELECT id, tenant_id` with a schema-locked view, not a raw table reference.

#### SEC-007 — Accountant tables are not RLS-protected; reseller commissions readable cross-firm
- **Severity:** HIGH
- **Files:**
  - `apps/api/migrations/1710000700000_accountant.cjs`
  - `apps/api/migrations/1710000800000_billing.cjs`
  - `apps/api/src/modules/accountant/accountant.service.ts`
- **Description:** `accountant_firms`, `accountant_client_links`, and `reseller_commissions` deliberately have NO RLS — the comment reads "Public tables (no RLS) — service layer enforces authorization". Every service-layer query filters by `firm_id = firm.id`, so the current code is safe, but one future `tx.select().from(accountantClientLinks)` with no filter would leak every firm's client book cross-firm. There is also no defense in depth at the DB.
- **Remediation:** Add RLS keyed off a new `app.user_id` or `app.firm_id` setting that `AccountantAuthGuard` sets alongside `app.tenant_id`. Short-term: an eslint rule / review checklist flagging bare `select().from(accountantClientLinks)`.

### MEDIUM

#### SEC-008 — Logger redaction misses VATINs, request bodies, correlation IDs
- **Severity:** MEDIUM
- **File:** `apps/api/src/app.module.ts`
- **Description:** `redact: ['req.headers.authorization']` is the only redaction. On 4xx / 5xx `pino-http` emits `req` but not `req.body` by default, so DTOs are usually not leaked — but adding `logBody: true` or an interceptor would silently start exfiltrating VATINs, buyer names, and amounts into log aggregation. There is no `pii: *` deny-list posture. Also `customProps` injects `tenantId` on every line, which is the intended audit trail but means a leaked log line can be attributed to a tenant automatically; combined with the leads table (SEC-005), lead-form logs could carry phones + emails.
- **Remediation:**
  1. Extend `redact` to `['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.ublXml', 'req.body.base64', '*.vatin', '*.email', '*.phone']` with `remove: false` so the shape is preserved.
  2. Add a review checklist entry: no new fields logged without a redaction entry.

#### SEC-009 — Archive filesystem adapter default path is `/tmp/faatora-archive`
- **Severity:** MEDIUM (dev-only; CRITICAL if ever enabled in prod)
- **File:** `apps/api/src/modules/archive/filesystem-storage.ts`
- **Description:** `baseDir` falls back to `/tmp/faatora-archive`. Mode `0o400` prevents overwrite but a sibling process with the same UID can `chmod` and overwrite — the hash chain in `archiveRecords.chainHash` would catch tampering at verify-time, but the archived payload itself could be lost. Also `/tmp` is reaped on reboot in some container runtimes.
- **Remediation:** Refuse to boot the filesystem adapter when `NODE_ENV==='production'`. Default `FAATORA_ARCHIVE_DIR` to a project-local dir under the app user's home in dev.

#### SEC-010 — Guard rejects on `authorization` header, but not on token re-use after membership drop
- **Severity:** MEDIUM
- **File:** `apps/api/src/auth/tenant.guard.ts`
- **Description:** On every request, the guard verifies the Cognito token, fetches the user by `cognito_sub`, then confirms a membership exists. If a user is removed from a tenant mid-session, their still-valid access token (up to 60 min) will stop working on the next request — good. But there is no revocation path for a stolen token short of its lifetime, and `enable_token_revocation = true` in `infra/modules/auth/main.tf` is wired but no code path calls Cognito's `RevokeToken`. **Also:** case sensitivity — Node normalizes headers to lowercase, so the current lookup is correct, but any Nest adapter swap (fastify) must preserve this.
- **Remediation:** Add an admin endpoint to call `cognito-idp:RevokeToken` on offboarding. Document that TTL is 60 min.

#### SEC-011 — PDF generator interpolates invoice fields with incomplete escaping
- **Severity:** MEDIUM
- **File:** `apps/api/src/modules/signing/pdf.ts`
- **Description:** `escapePdfText` escapes `\`, `(`, `)` but not newlines or non-ASCII control bytes. Invoice `number` is user-supplied (from `CreateInvoiceDto`), minimum validation. A `number` containing a newline + `) Tj ET endobj` could truncate the content stream. Low exploitability — the signed artifact is the UBL XML, not the PDF, and the PDF is a Wave-2 stub — but once the PDF becomes PDF/A-3 with the XML embedded, this becomes a vector for a malformed PDF that nonetheless carries a correct signature.
- **Remediation:** Replace the handwritten PDF emitter with pdfkit or similar before Wave 4; while the stub lives, extend `escapePdfText` to strip `\x00-\x1f` and `\x7f`.

#### SEC-012 — `exportForAuditor` has no row cap; can return a whole tenant's archive
- **Severity:** MEDIUM
- **File:** `apps/api/src/modules/archive/archive.service.ts`
- **Description:** The method streams every `archive_records` row in `[from, to]`. For a tenant with hundreds of thousands of invoices this is a memory and connection-time cliff.
- **Remediation:** Add a hard `LIMIT 10_000` with a `nextPageToken` based on `(archived_at, id)`; or stream row-by-row.

#### SEC-013 — Cognito pool region defaults to `me-south-1` but data residency not asserted
- **Severity:** MEDIUM
- **Files:** `infra/variables.tf`, `apps/api/src/config/env.ts`
- **Description:** Terraform default region is `me-south-1` (Bahrain) which is the closest in-region AWS option for Oman data-residency. There is NO guard in code that `AWS_REGION` cannot be `us-*` / `eu-*`; and nothing forces the Cognito pool, KMS keys, and S3 archive bucket to be in the same region. An OTA audit will fail if any one of these three sits outside the sanctioned residency scope.
- **Remediation:** Boot-time check: refuse to start if `AWS_REGION` matches `^(us|eu|ap)-` in prod; add a Terraform validation rule that enforces residency.

### LOW / COSMETIC

#### SEC-014 — `tally` XML parser disables entity expansion (correct) but silently truncates numeric values
- **Severity:** LOW
- **File:** `apps/api/src/modules/imports/parsers/tally.parser.ts`
- **Description:** `fast-xml-parser@4.5.7` does not expand external entities, so XXE is not a vector here. However, `parseRate` strips a unit suffix via `^-?\d+(\.\d+)?` which will silently clip values with scientific notation (`1e3/Nos`) to `1`. This is a correctness bug not a security bug — flagging as LOW because imported invoices feed signing.
- **Remediation:** Use `Number(s.split('/')[0])` and reject on `!Number.isFinite`.

#### SEC-015 — `calculateCommission` uses raw SQL; parameterization is correct
- **Severity:** COSMETIC
- **File:** `apps/api/src/modules/accountant/accountant.service.ts`
- **Description:** Confirmed: `from` and `to` are validated with `/^\d{4}-\d{2}-\d{2}$/` and then passed via Drizzle `sql`` template which binds as parameters. No SQL injection surface. Flagging only to document that this was reviewed.

#### SEC-016 — Drain controller `/clearance/drain` has no admin-role gate
- **Severity:** LOW
- **File:** `apps/api/src/modules/clearance/clearance.controller.ts`
- **Description:** `POST /clearance/drain` is behind `TenantGuard` but any tenant user can trigger a global drain tick (bounded to `limit=50`). Not an isolation break — the drain itself is tenant-scoped under the hood — but it lets any user force outbound ASP traffic.
- **Remediation:** Require role=`owner` or move the drain to the internal scheduler only.

#### SEC-017 — `qrPngBase64` + `pdfBase64` stored in Postgres (`signed_documents`)
- **Severity:** LOW
- **File:** `apps/api/src/db/schema/signing.ts`
- **Description:** PNG and PDF (future PDF/A-3) are inlined as base64 TEXT columns on every signed invoice row. At scale this fills the WAL and the primary. Not a security issue strictly, but a data-exposure amplifier: a stray `SELECT *` dumps the full visual document.
- **Remediation:** Move the blobs to the archive bucket; keep only pointers in `signed_documents`.

#### SEC-018 — QR payload supplier VATIN is intentional; no PII beyond invoice metadata
- **Severity:** INFORMATIONAL
- **File:** `apps/api/src/modules/signing/qr.ts`
- **Description:** `FaatoraQrPayload` includes `uuid, n, d, gt, vt, svat`. The supplier VATIN is required by the OTA interim spec. No buyer VATIN, no bank details, no addresses leak into the QR. Confirmed safe.

---

## 4. Omani regulatory posture

| Requirement | Current state | Gap |
|---|---|---|
| **In-region data residency** | Terraform default `me-south-1`; no runtime guard. | SEC-013 — needs a boot-time region check and a Terraform validation rule. |
| **HSM-backed invoice signing** | `aws_kms_key.signing` provisioned (RSA_2048 SIGN_VERIFY). `KmsSigner` is a stub. | SEC-002 — complete KMS wiring and remove `LocalSigner` from prod bindings. |
| **10-year immutable archive** | S3 Object Lock COMPLIANCE + versioning + public-access-block configured correctly. | On its own, fine. The per-tenant hash chain (`archive_records.chain_hash`) is implemented and verifies on `GET /archive/verify-chain`. |
| **Server-rebuilt UBL (invoice integrity)** | **NOT MET.** `POST /invoices/:id/sign` signs attacker-supplied XML. | SEC-001 — must rebuild server-side from DB rows before signing. |
| **Key rotation runbook** | KMS asymmetric key has `enable_key_rotation=false` (AWS limitation — asymmetric CMKs do not rotate automatically). A7 stub only. | Document a manual, dual-signed key-rotation runbook with cutover + verification steps before accreditation. |
| **ASP accreditation (white-label consumer)** | Wave-3 stub ASP wired in-process via `StubAspProvider`. | Needs: HMAC-verified callback (SEC-003), ASP vendor name on the audit trail, PINT-OM profile sign-off before the stub flips to real. |
| **Audit log immutability** | `clearance_events` is append-only in service code; no DB trigger preventing UPDATE/DELETE. `faatora_app` has `UPDATE, DELETE` grant. | Add trigger `clearance_events_no_update_delete` and revoke `UPDATE, DELETE` on `clearance_events` from `faatora_app`. |
| **MFA for operators** | Cognito `mfa_configuration = var.mfa_configuration` (variable, not pinned ON). | Pin `mfa_configuration = "ON"` for the accountant pool before go-live. |
| **Breach-notification SLA (OTA 72h)** | No runbook. | Author `docs/runbooks/breach-notification.md`. |

---

## 5. Pre-production security to-do list

| ID | Action | Owner | Effort | Hard dependency |
|---|---|---|---|---|
| **PP-1** | SEC-001: rebuild UBL server-side; remove `ublXml` from `SignInvoiceDto`. | Signing team (A4) | 2 days | Compliance builder (@faatora/compliance) finished — blocks PP-2 |
| **PP-2** | SEC-002: wire `KmsSigner`; gate `signing.module.ts` provider on `NODE_ENV`. | Platform | 1 day | PP-1 (shared signer surface) |
| **PP-3** | SEC-003: design + ship ASP callback HTTP controller with HMAC verification + `clearance_callbacks_seen` dedupe table. | Clearance (A14) | 3 days | ASP vendor selection |
| **PP-4** | SEC-004: parameterize `faatora_app` password via SSM; add boot-time refusal if password equals role name. | Platform | 4h | Secrets-manager runbook |
| **PP-5** | SEC-005: add `@nestjs/throttler` to leads route; fix phone regex; set `trust proxy`; add WAF rate rule. | Growth/Platform | 1 day | — |
| **PP-6** | SEC-006: fail boot in prod if `MIGRATION_DATABASE_URL` unset; add CI assertion for `rolbypassrls=false`. | Platform | 4h | — |
| **PP-7** | SEC-007: add RLS to accountant tables keyed on `app.user_id`; or an eslint rule flagging bare `select().from(accountantClientLinks)`. | Accountant (A12) | 1 day | — |
| **PP-8** | SEC-008: extend pino `redact` list; add logging-review entry to PR template. | Platform | 2h | — |
| **PP-9** | SEC-009: refuse `FilesystemStorage` in prod; default dev path to `~/.faatora/archive`. | Archive (A13) | 2h | — |
| **PP-10** | SEC-013: boot-time `AWS_REGION` guard + Terraform validation. | Platform/Infra | 4h | — |
| **PP-11** | Add DB trigger + revoke `UPDATE,DELETE` on `clearance_events` from `faatora_app`. | DBA | 4h | — |
| **PP-12** | Pin Cognito `mfa_configuration = "ON"` in Terraform; document enrolment flow. | Infra | 2h | — |
| **PP-13** | Author key-rotation runbook (`docs/runbooks/key-rotation.md`) + breach-notification runbook (72h OTA SLA). | Security | 1 day | — |
| **PP-14** | SEC-016: gate `POST /clearance/drain` on `role==='owner'`. | Clearance | 1h | — |
| **PP-15** | SEC-017: move `qr_png_base64` / `pdf_base64` out of Postgres into the archive bucket, keep pointers. | Signing/Archive | 2 days | PP-2 (we only touch rows we can sign again) |

Total: ~2 engineer-weeks on the critical path (PP-1 → PP-2 → PP-3), ~1 engineer-week of parallelizable hardening (PP-4..PP-15).

---

## 6. Counts

- **CRITICAL:** 3 (SEC-001, SEC-002, SEC-003)
- **HIGH:** 4 (SEC-004, SEC-005, SEC-006, SEC-007)
- **MEDIUM:** 6 (SEC-008, SEC-009, SEC-010, SEC-011, SEC-012, SEC-013)
- **LOW / COSMETIC:** 5 (SEC-014, SEC-015, SEC-016, SEC-017, SEC-018)

**Overall posture: Dev-ready.** Not production-ready until the three CRITICAL items and SEC-004 / SEC-006 are closed.
