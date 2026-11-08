# A19 — Test coverage and quality review

Scope: every `*.spec.ts` under `apps/api/test/` and `packages/compliance/test/`,
plus a read-through of each service/controller the specs exercise.

Verification: `pnpm lint` passes (eslint + prettier) as of 2026-10-17.

---

## 1. Current state

### Tests by package / file

| Package | File | `it` blocks |
|---|---|---:|
| apps/api | `health.spec.ts` | 1 |
| apps/api | `tenant-isolation.spec.ts` | 3 |
| apps/api | `money.spec.ts` | 3 |
| apps/api | `leads.spec.ts` | 6 |
| apps/api | `pos.spec.ts` | 5 |
| apps/api | `signing.spec.ts` | 10 |
| apps/api | `imports.spec.ts` | 13 |
| apps/api | `clearance.spec.ts` | 10 |
| apps/api | `accountant.spec.ts` | 10 |
| apps/api | `archive.spec.ts` | 10 |
| apps/api | `billing.spec.ts` | 17 |
| apps/api | `bookkeeping.spec.ts` | 8 |
| apps/api | `observability.spec.ts` | 13 |
| **apps/api subtotal** | | **109** |
| @fawtara/compliance | `semantic.spec.ts` | 13 |
| @fawtara/compliance | `pint-om.spec.ts` | 6 |
| @fawtara/compliance | `ubl.spec.ts` | 17 |
| @fawtara/compliance | `validate.spec.ts` | 33 |
| @fawtara/compliance | `corpus.spec.ts` | 2 static + 15 generated |
| **compliance subtotal** | | **~86 (71 static + 15 fixture-generated)** |
| **Grand total observed** | | **~195** |

### Integration (hits live Postgres) vs unit-only

Pure unit (no DB, no network):

- `money.spec.ts` — pure function `computeTotals`
- `leads.spec.ts` — pure function `assessReadiness`; `LeadsService.create` (the DB insert) is NOT tested
- `signing.spec.ts` — `LocalSigner` + a scripted/mocked `SigningService` (DB stub)
- `observability.spec.ts` — in-process metrics registry; `QueueDepthSamplerService` and `CanaryService` are driven with hand-rolled fake `pg.Pool` / `{ execute }` stubs
- `health.spec.ts` — Nest `HealthModule` wired on its own, no DB
- All five compliance specs — pure TypeScript, no I/O

Hits live Postgres (`DATABASE_URL` + `MIGRATION_DATABASE_URL`):

- `tenant-isolation.spec.ts`
- `accountant.spec.ts`
- `archive.spec.ts`
- `billing.spec.ts`
- `bookkeeping.spec.ts`
- `clearance.spec.ts`
- `imports.spec.ts`
- `pos.spec.ts`

Everything in the "live Postgres" bucket runs through the real `withTenant` /
RLS path, so each one is simultaneously a service-level test and an RLS
regression. There is no mocked-DB coverage for `InvoicesService`,
`PartiesService`, or `LeadsService.create` — these services currently have
no spec file of their own at all.

### Transport-layer coverage

Only `health.spec.ts` and the `/metrics` test in `observability.spec.ts`
boot a Nest app and go through `supertest`. Every other spec constructs
the service directly with `new …(db)`. There is **no HTTP-level test for a
single business controller** — not for clearance, archive, imports,
accountant, invoices, parties, signing, bookkeeping, pos, billing or
leads. `TenantGuard` and the Cognito verifier are therefore completely
untested.

---

## 2. Coverage map (service methods)

Legend: Y / N / partial. "Error paths" means at least one explicit
`rejects.toThrow`/exception-class assertion on the method. "RLS" means at
least one assertion checks tenant isolation via `withTenant`.

| Module | File | Covered methods | Uncovered methods | RLS? | Error paths? |
|---|---|---|---|:-:|:-:|
| accountant | `accountant.service.ts` | `createFirm`, `getFirmForUser`, `listMyTenants`, `linkClient`, `consolidatedKpis`, `calculateCommission` | **`unlinkClient`** | Y (via consolidatedKpis) | Y |
| archive | `archive.service.ts` | `archiveInvoice`, `getRecord`, `getContent`, `verifyChain`, `exportForAuditor` | — | Y | Y (invoice-not-cleared, EEXIST) |
| archive | `filesystem-storage.ts` | `put` (via archiveInvoice + 1 dedicated test) | **`get`**, **`exists`** (not asserted explicitly) | — | partial (EEXIST only) |
| archive | `s3-storage.ts` | — | **entire class** (`put`, `get`, `exists`) | N | N |
| archive | `hash-chain.ts` | `sha256Hex`, `computeChainHash` | — | n/a | n/a |
| billing | `billing.service.ts` | `generateMonthlyBilling`, `markPaid`, `computeBilling` (pure) | **`list`**, **`get`** | Y | partial (no "already paid" / "void" test for markPaid) |
| billing | `commissions.service.ts` | `accrue` (via billing flow) | **`markPaid`**, **`listByFirm`**, direct `accrue` call | N | N |
| billing | `metering.service.ts` | `increment`, `getUsage`, `onInvoiceIssued` | — | partial (idempotency row test) | N |
| billing | `plans.service.ts` | `list`, `getByCode` | **`getById`** | n/a (public) | partial (getByCode-missing not asserted) |
| billing | `subscriptions.service.ts` | `subscribe`, `getActive`, `addOneMonth` | **`cancel`** | Y | N |
| bookkeeping | `accounts.service.ts` | `seedCoa`, `list` | **`get`**, **`create`** | Y | N |
| bookkeeping | `journals.service.ts` | `postManual`, `postInvoiceIssued` | **`list`**, **`get`**, **`postPaymentReceived`**, **`postBillReceived`**, **`postPaymentPaid`** | Y (one test) | partial (unbalanced only) |
| bookkeeping | `payments.service.ts` | `create`, `list` | **`get`** | Y | N |
| bookkeeping | `reports.service.ts` | `trialBalance`, `vatReturn` | **`profitAndLoss`**, **`balanceSheet`** | N | N |
| bookkeeping | `supplier-bills.service.ts` | `create`, `get`, `list` | — | Y | N |
| clearance | `clearance-gateway.service.ts` | `enqueue`, `drainOnce`, `handleCallback`, `closeInternalPool` (indirect) | **`retry`**, **`listEvents`**, **`status`** | Y | partial (DLQ, breaker, async idempotency) |
| clearance | `circuit-breaker.ts` | `isOpen` + `recordFailure` (indirect) | `recordSuccess`, half-open window reopen path, `snapshot()` as unit | n/a | N |
| clearance | `state-machine.ts` | — (used only through gateway) | **`isValidTransition`**, **`assertCanTransition`** as units; `InvalidTransitionError` not asserted directly | n/a | N |
| clearance | `stub-asp.ts` | sync success, forceReject, async callback (via gateway) | `resetStubAspState` called in `beforeEach` but idempotency cache behaviour is not asserted directly | n/a | n/a |
| clearance | `clearance-scheduler.ts` | — | **entire class** | — | — |
| health | `health.controller.ts` | GET /health | — | n/a | n/a |
| imports | `imports.service.ts` | `startImport`, `listJobs`, `getJobWithErrors` | — | Y | Y (bad qty, dup number, cross-tenant) |
| imports | `parsers/csv.parser.ts` | header + good + bad-qty | missing optional columns, CRLF, BOM | n/a | Y |
| imports | `parsers/excel.parser.ts` | good + bad-qty | multi-sheet, empty row handling | n/a | Y |
| imports | `parsers/tally.parser.ts` | 1-voucher happy + missing-number + bad-qty | multiple vouchers in one envelope, nested ledger entries, non-sales vouchers | n/a | Y |
| invoices | `invoices.service.ts` | — | **`create`**, **`list`**, **`get`**, **`issue`** (DRAFT → VALIDATED gate, compliance port wiring, no-lines, bad party) | N | N |
| invoices | `parties.service.ts` | — | **`create`**, **`list`**, **`get`** | N | N |
| invoices | `money.ts` | `computeTotals` | — | n/a | N |
| invoices | `compliance.pipeline.ts` | — | **entire adapter** (how the service dialogues with @fawtara/compliance) | N | N |
| leads | `leads.service.ts` | — (only `readiness.ts` pure function) | **`create`** (the DB write, IP capture) | N | N |
| leads | `readiness.ts` | `assessReadiness` | — | n/a | n/a |
| pos | `products.service.ts` | `create`, `findBySku`, RLS insert | **`get`**, **`findByBarcode`**, **`update`**, **`archive`** | Y | partial (missing sku) |
| pos | `sales.service.ts` | `createSale`, `batchPendingToInvoice`, `endOfDayReport`, sequence allocator | **`list`** (filters), **`get`** | partial | N |
| signing | `signing.service.ts` | `sign` happy + 3 reject paths + existing-UUID reuse (DB mocked, no RLS) | — (but mocked, so RLS/concurrency gaps around status re-check are not exercised) | N | Y |
| signing | `local-signer.ts` | `sign`, `verify`, `getPublicKeyPem` | — | n/a | partial |
| signing | `kms-signer.ts` | — | **entire class** | n/a | N |
| signing | `qr.ts` | `generateQrPng`, `buildQrPayload` (indirect) | explicit `buildQrPayload` field-level assertions | n/a | N |
| signing | `pdf.ts` | — | **`renderPdf`** (byte-level), only exercised in-passing via `signing.service` mock asserting `pdfBase64.length > 0` | n/a | N |
| auth | `tenant.guard.ts` | — | **`TenantGuard.canActivate`** (header parsing, 401 vs 403, membership lookup) | n/a | N |
| auth | `cognito.ts` | — | **`getCognitoVerifier`** (lazy singleton, env config) | n/a | N |
| db | `with-tenant.ts` | `withTenant` (via every integration spec) | — | Y | N |
| observability | `metrics.ts`, `metrics.controller.ts`, `http-metrics.middleware.ts`, `canary.service.ts`, `queue-depth-sampler.service.ts` | listed in spec | **`webhook-alert-sink.ts`** entire file; `LogAlertSink` only inspected via module metadata | n/a | partial |

**Compliance package — all five source dirs well-covered:**

| Module | Covered |
|---|---|
| `canonical/zod.ts`, `canonical/types.ts` | `validateCanonical` (positive + 3 negatives) |
| `semantic/map.ts`, `semantic/en16931.ts` | `canonicalToSemantic` header, parties, line math, BG-23 grouping, baisa rounding |
| `pint-om/specialize.ts` | `semanticToPintOm` incl. OM_VAT_SCHEME, documentUuid passthrough |
| `ubl/serializer.ts` | shape, namespaces, element order, currency scale OMR vs USD, type-code mapping, determinism, UUID insertion |
| `ubl/parser.ts` | roundtrip + 3 negative cases |
| `validate/vat-math.ts` | OM-VAT-001/004/005 fire paths |
| `validate/xsd-lite.ts` | OM-XSD-001/002/003 |
| `validate/schematron-lite.ts` | every BR / BR-CO / BR-S / BR-Z / BR-E / BR-OM rule has at least one positive and (where applicable) one negative — this file is thorough |
| `validate/pipeline.ts` | happy path, CANON-001 early-exit, semantic-only entry, OM warning passthrough |
| `codelists/*` | — (no direct tests, implicitly covered by valid-fixtures) |

**Uncovered-method count across apps/api service layer: 38 methods** (plus
3 entire classes: `S3Storage`, `KmsSigner`, `ClearanceScheduler`, and the
`webhook-alert-sink`).

---

## 3. Golden corpus assessment

Current corpus: 15 fixtures (8 valid + 7 invalid). The corpus is a true
regression harness — every rule in `schematron-lite.ts` is exercised by at
least one fixture *and* has a direct unit test. That is good, but the
corpus is thin on real-world edges. The 10 fixtures below should be added.

| Missing fixture | Rule(s) exercised | Why it matters |
|---|---|---|
| **valid-09-multi-currency-usd.json** | `BR-OM-002` (warning only), currency scaling (BT-5=USD, 2 dp instead of 3) | USD is a plausible export currency for OM-registered sellers invoicing abroad; today the only non-OMR case is a schematron warning fixture — we have **no fixture that validates a USD invoice end-to-end through serializer + parser**. Without it the 2-dp code path in `ubl/serializer.ts` has no corpus-level regression. |
| **valid-10-multi-currency-aed.json** | currency scaling (AED, 2 dp), GCC cross-border assumption | GCC cross-border is a near-term customer scenario; AED is the next most likely non-OMR currency after USD. |
| **invalid-08-credit-note-missing-reference.json** | would exercise a future `BR-OM-004` (credit notes must reference an original invoice via BT-25) | **BT-25 does not exist on the canonical type yet.** A fixture with the expected rule name forces the schema to grow a `creditNoteReferences` field and the schematron to enforce it — this is a known gap for e-invoicing (OTA rejects an unreferenced 381). |
| **valid-11-line-discount.json** | future BT-136 (line allowance) + would require `BR-CO-23` (BT-131 = qty×price − allowance + charge) | Line-level discounts are everyday real-world invoices. Today `computeTotals` has no allowance/charge path and `semantic/map.ts` zeroes them silently. A fixture here is a planning artefact that will drive A-wave work. |
| **valid-12-high-decimal-quantity.json** | `canonicalToSemantic` with `quantity: 0.001` and a tiny unit price — tests baisa rounding at a quantity scale beyond 3 dp | Weigh-based sellers (kg, m³) ship 0.001 kg quantities. The one existing baisa fixture (`valid-07-fractional-baisa`) tests `unitPrice=0.105 × quantity=1`, not quantity rounding. If we silently truncate `quantity` to 3 dp we will mis-compute totals. |
| **invalid-09-supplier-equals-buyer.json** | would exercise a future `BR-OM-005` (BT-27 supplier ≠ BT-44 buyer) | Protects against self-invoicing (data-entry bug, or an attempt to game the clearance pipeline). The current pipeline accepts it silently. |
| **invalid-10-zero-grand-total.json** | would exercise a future `BR-OM-006` (BT-112 > 0 after allowances) | A fully discounted invoice (100% line discount) today clears all BR-CO rules because 0 = 0 + 0, but OTA would reject it. The corpus needs a negative fixture that proves we flag it. |
| **valid-13-utf8-arabic-description.json** | `pintOmToUbl` XML-escaping behaviour, UTF-8 byte handling, PDF label widths | Oman is a bilingual market. Nothing in the corpus asserts that an Arabic `description` survives serializer → parser → signer → QR without mojibake. Also catches any regression that drops non-ASCII from the SHA-256 input. |
| **valid-14-very-long-line-description.json** | nothing new in rules; catches regressions in `renderPdf` wrapping, DB column length, XML attribute size | 2k-char descriptions (service invoices, legal copy) break PDF rendering and *may* trigger varchar overflow at the DB layer. A corpus-level fixture lets us assert the pipeline handles it without truncating. |
| **valid-15-tz-boundary-issue-date.json** | `BR-OM-003` (future-dated), timezone handling across issueDate + archive retention | An invoice issued at 23:59 UTC on 2026-12-31 is 03:59 2027-01-01 in Oman (UTC+4). `todayUtcIso()` in `schematron-lite.ts` compares as UTC, but the business operates in GST. The current rule rejects "issueDate > today-UTC"; this fixture pins the current UTC-based behaviour so we don't accidentally shift it under a feature-flag migration. |
| *(bonus)* **valid-16-b2c-simplified.json** | would exercise a future `BR-OM-007` (B2C simplified invoice — QR mandatory, buyer VATIN absent) | POS batching already produces B2C summary invoices with no buyer VATIN. There is no fixture asserting that the pipeline allows (no `BR-07` on an empty VATIN) a B2C invoice *and* enforces the QR-present invariant for that case. |

---

## 4. Flakiness and dependency risks

### Live Postgres assumptions

- Every integration spec creates its own tenants with `randomUUID()` so there
  is **no reliance on default seeded tenants or users** — good. The one
  exception is `billing.spec.ts > plans catalog` which asserts that
  `plans.list()` returns at least `basic` and `pro` by code. This leans on
  the migration having seeded two plans; if a future migration renames
  `basic` → `starter` the whole billing spec breaks. The test should list
  by capability (included invoices > 0) rather than by code string.
- `accountant.spec.ts > calculateCommission` relies on
  `information_schema` for a table-existence guard rather than asserting
  the migration ran. This is defensive but hides a real failure mode: if
  the `billing_invoices` migration regresses, the test silently passes.
- `clearance.spec.ts` relies on seed-free state but talks to the
  `clearance_outbox`, `clearance_events` and `clearance_dlq` tables
  directly — it both inserts cross-tenant and cleans up in `beforeEach`
  (see below).

### Timing / real-sleep patterns

Several tests use **real** `setTimeout`, not fake timers:

- `clearance.spec.ts` lines 400, 426: `await new Promise((r) => setTimeout(r, 150))` after `drainOnce` to wait for the stub ASP's 50ms async callback. Pattern: real sleep with a 100ms slack. Flaky risk: on a loaded CI box the 50ms setTimeout may land after 150ms and the test will see the pre-callback state. Should either expose a hook on `StubAspProvider` to resolve a `Promise<void>` when the callback fires, or use `jest.useFakeTimers()` with `jest.advanceTimersByTime(60)`.
- `observability.spec.ts` line 152: `await new Promise((r) => setTimeout(r, 2))` to produce a non-zero histogram duration. 2ms is small enough that a GC pause could swallow it; harmless (the assertion is `_count` not value) but still a code smell.
- `clearance.spec.ts > circuit breaker` and `> DLQ` manipulate `next_attempt_at` directly in SQL rather than advancing fake time. This is the right trade-off (the breaker's `openUntil` is `Date.now()`-based) but makes a test harness that is itself untestable: a bug in the time-rewind SQL would be invisible.
- No test uses `jest.useFakeTimers()` anywhere. For the circuit breaker's half-open-after-60s path (currently uncovered) that would be the cleanest approach.

### Shared state leaks

- **`stub-asp.ts` holds a module-scoped `idempotencyCache` Map.** The spec
  explicitly imports `resetStubAspState` and calls it in `beforeEach`.
  Good — but only `clearance.spec.ts` does this. If a future test file
  imports `StubAspProvider` and does not call `resetStubAspState`, a
  previous suite's cache survives. There is no central `jest.setup.ts`
  that resets it. Consider either moving the cache onto the provider
  instance (making it DI-reset-safe) or registering the reset in a shared
  setup hook.
- **`circuit-breaker.ts`** state is instance-local (good — each spec
  constructs its own `TransmissionCircuitBreaker`), but the test uses
  `(gw as unknown as { breaker }).breaker` to poke it and call `reset()`.
  That hack indicates the breaker should expose a test-only entry on the
  gateway instead.
- **`observability.spec.ts`** correctly calls `_resetRegistryForTests()`
  in `afterEach` for the helper suites — but the first describe
  (`metrics endpoint`) does not reset, so its `fawtara_http_requests_total`
  counter accumulates across runs. Not currently a problem (nothing
  asserts the absolute value), but a trap for the next person.
- **`process.env` mutation without restore:**
  - `clearance.spec.ts` line 23: `process.env.DISABLE_CLEARANCE_CRON = '1'` — set at module load, never restored. Fine for CI (process exits) but bleeds into any spec that imports from this file via a shared `--testPathPattern`.
  - `clearance.spec.ts` sets and `delete`s `process.env.STUB_ASP_MODE` across tests — this is correct.
  - `archive.spec.ts` line 76: `process.env.FAWTARA_ARCHIVE_DIR = archiveDir` — set in `beforeAll`, never restored in `afterAll`.

### DB cleanup order

- `clearance.spec.ts > afterAll` explicitly deletes from `clearance_outbox`,
  `clearance_events`, `clearance_dlq` before `tenants`. Good, defensive.
  `billing.spec.ts > afterAll` relies on `tenants` CASCADE for subscriptions
  / usage_meters / billing_invoices / reseller_commissions — correct only
  if the FKs are `ON DELETE CASCADE`. If a future migration adds a new
  billing table without the cascade, the suite leaks rows.
- `archive.spec.ts` creates/deletes multiple ad-hoc tenants mid-suite
  (`ARC-CHAIN`, `ARC-TAMPER`, `ARC-EXPORT`) in try/finally — the pattern
  is sound.

### `--runInBand`

`apps/api/package.json` passes `--runInBand`, so no parallelism — this
hides any cross-file conflicts that would surface under `--maxWorkers=4`.
At the current scale this is fine, but it is deferring a problem rather
than solving it.

---

## 5. Testing gaps that would catch real bugs

Severity scale: **HIGH** = plausible bug in a shipping path, **MEDIUM** =
plausible bug in a less-trafficked path, **LOW** = correctness hygiene.

- **GAP-01 (HIGH)**: Clearance callback for an invoice already `CLEARED` must be idempotent *at the HTTP layer*. The service-level `handleCallback` idempotency is tested (`clearance.spec.ts` line 415) but there is no HTTP route that receives a webhook callback, and no `supertest` test proving the controller (when it exists in A17) returns 200 and no-ops. Today a replay from the ASP would be a service call; tomorrow a webhook controller is likely to be added and this test should be in place before it ships. *File:* `apps/api/test/clearance-callback.e2e-spec.ts`. *Effort:* 2h.
- **GAP-02 (HIGH)**: `InvoicesService.issue` compliance-port failure path. The service wires the real `@fawtara/compliance` validator through `COMPLIANCE_VALIDATOR`. There is zero test proving that an invoice with a known broken shape (BT-106 mismatch) is rejected with `UnprocessableEntityException` and NOT moved out of `DRAFT`. Currently `invoices.service.ts` has **no spec file**. *File:* `apps/api/test/invoices.spec.ts`. *Effort:* 3h.
- **GAP-03 (HIGH)**: `TenantGuard` behaviour. The guard parses `x-tenant-id`, looks up membership, and attaches `AuthContext`. Nothing tests it. A regression that lets anyone pass `x-tenant-id: <other>` would be invisible to the current suite — the integration specs bypass the guard entirely. *File:* `apps/api/test/tenant-guard.spec.ts`. *Effort:* 3h.
- **GAP-04 (HIGH)**: Signing concurrency — two concurrent `sign` calls on the same `VALIDATED` invoice. The current test (`signing.spec.ts`) uses a scripted DB stub, so the "status re-check inside the transaction" path cannot be probed. A hand-built integration test with `Promise.all` of two `svc.sign(…)` on the same invoice ID would prove the second one errors with `BadRequestException` ("status is not VALIDATED") rather than inserting two `signed_documents` rows. *File:* `apps/api/test/signing-integration.spec.ts`. *Effort:* 4h.
- **GAP-05 (HIGH)**: Circuit breaker half-open probe after 60s. `TransmissionCircuitBreaker.isOpen` resets `consecutiveFailures = 0` once `openUntil` elapses, letting the next drain probe. The DLQ test disables this behaviour by calling `breaker.reset()` manually. Nothing tests the half-open path. Use `jest.useFakeTimers()`, trip the breaker, `jest.advanceTimersByTime(60_001)`, assert the next `drainOnce` calls the provider exactly once. *File:* `apps/api/test/clearance.spec.ts` (new `describe('breaker half-open')`). *Effort:* 2h.
- **GAP-06 (HIGH)**: `ClearanceGatewayService.retry` for a `delivered` row must be rejected. The branch exists (`row.status === 'delivered'` → `BadRequestException`) but the method has no direct test. *File:* `apps/api/test/clearance.spec.ts`. *Effort:* 30m.
- **GAP-07 (HIGH)**: `state-machine.ts` exhaustive table test. `isValidTransition` is tested only through `ClearanceGatewayService`, which exercises SIGNED→SUBMITTED and SUBMITTED→CLEARED/REJECTED. A `it.each` of all (from, to, actor) tuples would (a) catch future actor-privilege regressions and (b) assert `InvalidTransitionError` is thrown with the right error name/message. *File:* `apps/api/test/state-machine.spec.ts`. *Effort:* 1h.
- **GAP-08 (MEDIUM)**: `BillingService.markPaid` on an already-paid invoice must be rejected (`void` is tested in the code path but the test only hits "flip to paid"). An idempotency case ("paying twice doesn't double-stamp `paidAt`") is also missing. *File:* `apps/api/test/billing.spec.ts`. *Effort:* 1h.
- **GAP-09 (MEDIUM)**: `ReportsService.profitAndLoss` and `balanceSheet` have no tests at all. A targeted test that seeds a journal and asserts income/expense totals + asset/liability balance is realistic and would catch the usual sign-flip bugs. *File:* `apps/api/test/bookkeeping.spec.ts`. *Effort:* 3h.
- **GAP-10 (MEDIUM)**: `ProductsService.update` + `archive` + `findByBarcode`. `pos.spec.ts` tests `create` and `findBySku` only. In particular, `archive` sets `archived=true` and later `findBySku` must exclude the row — this invariant is important for POS UX and is not asserted. *File:* `apps/api/test/pos.spec.ts`. *Effort:* 1h.
- **GAP-11 (MEDIUM)**: `LeadsService.create` DB side-effects: inserted row carries `verdict` as JSONB, `ip` recorded. The `assessReadiness` function is well-tested but the DB write path is not. *File:* `apps/api/test/leads-integration.spec.ts`. *Effort:* 1h.
- **GAP-12 (MEDIUM)**: `PartiesService` RLS test — a buyer created in tenant A is not visible from tenant B. The current `invoices.spec.ts` doesn't exist; `imports.spec.ts` has an indirect cross-tenant assertion via import jobs but not direct via `parties`. *File:* `apps/api/test/parties.spec.ts`. *Effort:* 1h.
- **GAP-13 (MEDIUM)**: Compliance validator — mixed-currency fixture. Today only `BR-OM-002` warns on non-OMR; nothing in the corpus walks a USD invoice through serializer *and* checks that `BR-CO-10` still passes when the stored BT-106 is in USD-scale (2 dp) instead of baisa (3 dp). See fixture GAP in §3. *File:* `packages/compliance/test/fixtures/valid-09-multi-currency-usd.json` + corpus entry. *Effort:* 1h.
- **GAP-14 (MEDIUM)**: Archive — `verifyChain` on a tenant with zero rows. Currently every verifyChain test seeds at least one archive; the empty-tenant path (`checked = 0, ok = true`) is implicit. A one-liner would pin it. *File:* `apps/api/test/archive.spec.ts`. *Effort:* 15m.
- **GAP-15 (LOW)**: Observability — `WebhookAlertSink` is entirely untested. `LogAlertSink` is only inspected via module metadata reflection. A test that stands up `WebhookAlertSink` with a fake fetch and asserts the POST body shape would prevent silent regressions in `on-call` paging. *File:* `apps/api/test/observability.spec.ts`. *Effort:* 1h.

---

## 6. Test infrastructure recommendations

### Jest config observations

- `apps/api/jest.config.js` is CommonJS and `packages/compliance/jest.config.cjs` is CommonJS — but the compliance package's **source** is NodeNext ESM with `.js` import specifiers, requiring the `moduleNameMapper: {'^(\\.{1,2}/.*)\\.js$': '$1'}` shim. This shim lives only in compliance's config. If `apps/api` ever imports an internal `.js`-ending path it will break. Document the pattern (or hoist a shared base config).
- Neither config sets `collectCoverage` or a coverage threshold. There is no `jest-junit` reporter and no `--ci` flag anywhere. CI logs today show pass/fail only.
- `apps/api` uses `--runInBand`. Fine for Postgres contention, but the compliance package does **not** need it and currently inherits serial execution via `pnpm -r test`. Compliance tests are pure — they could run `--maxWorkers=50%` for a measurable speedup once the two packages diverge.
- `apps/api/test/setup.ts` is a one-liner `config()` dotenv load — no global teardown, no shared pool. Adding a lightweight `globalSetup`/`globalTeardown` pair would let us (a) run `drizzle-kit migrate` once per test run instead of relying on an externally-prepared DB, and (b) centralise the `DISABLE_CLEARANCE_CRON = '1'` and `resetStubAspState()` toggles.

### Pattern inconsistencies

- **RLS seed helpers:** every spec rolls its own. `accountant.spec.ts`,
  `archive.spec.ts`, `bookkeeping.spec.ts`, `clearance.spec.ts`,
  `imports.spec.ts`, `pos.spec.ts` each define a local
  `insertParty`/`seedClearedInvoice`/`makeTenant`/`makeUser` function.
  Factor these into a `test/helpers/fixtures.ts` with
  `makeTenant`, `makeUser`, `makeParty`, `makeInvoice`, `makeSignedInvoice`.
  Current duplication is roughly 180 lines of near-identical SQL.
- **`withTenant` is the only clean pattern** — every spec uses it the
  same way for assertions. Keep that.
- **Direct `(gw as unknown as {breaker})` hacks** appear 3× in
  `clearance.spec.ts`. Expose a `__testOnly_resetBreaker()` on
  `ClearanceGatewayService` guarded by `NODE_ENV !== 'production'`, or
  pass a `TransmissionCircuitBreaker` instance into the constructor from
  the test and call `.reset()` on that handle directly.
- **Error-path style:** some tests use `expect(fn).rejects.toThrow(/regex/)`,
  others `rejects.toBeInstanceOf(ConflictException)`, others
  `rejects.toThrow()` bare. Converge on `rejects.toBeInstanceOf(…)` for
  Nest exceptions so the HTTP status becomes part of the contract.

### Coverage reporting proposal

- Add `jest --coverage --coverageReporters=text --coverageReporters=lcov`
  to a new `pnpm test:cov` script (per package). Publish the lcov from CI
  to Codecov or an in-repo artifact.
- Suggested first-pass thresholds (not stricter than today's reality):
  - Compliance package: `global: { lines: 85, branches: 80, functions: 90 }` — the specs genuinely cover this range already.
  - API: `global: { lines: 60, branches: 55, functions: 65 }` initial, raise to 75 after the GAP-02/03/09/10 work.
- Mark whole-file exclusions explicitly rather than letting them silently drag the number down: `s3-storage.ts`, `kms-signer.ts`, `clearance-scheduler.ts`, `webhook-alert-sink.ts` are infrastructure not currently targeted by tests. Add `/* istanbul ignore file */` or configure `coveragePathIgnorePatterns` with a comment pointing to the planned test file.

### Mutation testing (follow-up)

- Stryker (`@stryker-mutator/core` + `@stryker-mutator/jest-runner`)
  against the compliance package first — it is pure, fast, and the
  rule-pack-version string carries real consequences. Expected
  mutation-score target 70% on `packages/compliance/src/validate/*` once
  the GAP-13 fixtures land.
- API-side mutation testing is a Wave 5 concern — too expensive to run
  against the Postgres integration specs. If pursued, scope it to the
  pure modules (`invoices/money.ts`, `clearance/state-machine.ts`,
  `archive/hash-chain.ts`, `billing/billing.service.ts > computeBilling`,
  `signing/qr.ts`, `leads/readiness.ts`).

---

## 7. Verdict

The test suite is an accelerator for the compliance package and for the
state-machine-heavy slices of the API (archive, clearance, billing,
imports, accountant), but it is a brake for the two modules it never
touches directly — `InvoicesService` and `PartiesService` have no spec
file, and `TenantGuard` has no coverage at all, which means every refactor
of the request-ingress path is a leap of faith.
