# Runbook — Clearance rejection-rate spike

**Severity:** Warn (P2) — ASP is up, but a growing fraction of our submissions are rejected. Risk of per-tenant impact; escalates to P1 if a single reason code dominates and crosses the SLO burn-rate threshold.

## Symptoms

- `faatora_clearance_rejection_reason_total` increasing on one or more reason codes.
- `faatora_clearance_submissions_total{result="rejected"} / faatora_clearance_submissions_total` > 1% over 15 minutes (normal baseline is < 0.1%).
- Tickets from a specific tenant with "my invoice was rejected" messages.
- No corresponding spike in `result="error"` (so the ASP is up — this is a payload / content issue).

## Detection

- **Alert rule.** `sum(rate(faatora_clearance_rejection_reason_total[10m])) by (reason_code) > 0.5` and the rate for that code > 10x its 7-day baseline.
- **Log signal.** Pino lines with `event=clearance.submission.result` and `result=rejected`, grouped by `reason_code`.

## Immediate mitigation

1. **Identify the dominant `reason_code`.** `topk(5, sum by(reason_code)(increase(faatora_clearance_rejection_reason_total[15m])))`.
2. **Decide blast radius.**
   - **One tenant, one reason:** likely data quality issue in that tenant's input. Reach out to the tenant through CS; do not change platform config.
   - **Many tenants, one reason:** likely a rule-pack / data-dictionary change on the OTA side. Treat as an incident — see Investigation.
   - **Many tenants, many reasons:** likely a bug in our semantic → UBL mapping. Treat as P1, consider freezing the next release.
3. **Pause the drain** for the affected rule family only if we are producing *invalid* output (not if the input is bad): `POST /ops/clearance/drain/pause` with `{ "scope": "all" }`.

## Investigation steps

1. Pick 3 freshly-rejected invoices from the dominant reason code:

   ```sql
   SELECT invoice_id, raw_response
   FROM clearance_events
   WHERE to_state = 'rejected'
     AND at > now() - interval '15 minutes'
   ORDER BY at DESC
   LIMIT 10;
   ```

   Run against the migration-role connection (cross-tenant).

2. For each invoice, pull the stored UBL from `invoice_signed_payloads` and compare against the `raw_response`'s `faultCode` + `faultText`.

3. If the fault maps to a `rule_pack_version` field returned by the ASP, cross-check against our deployed `rule_pack_version` (see `/health/detailed`). A mismatch means the OTA shipped a new pack and we haven't adopted it yet — follow `docs/runbooks/data-dictionary-update.md`.

4. Where to find per-invoice clearance history: `clearance_events` holds the full state-machine audit trail keyed by `(tenant_id, invoice_id)`.

## Replay after fix

Once the root cause is fixed (data-dictionary adopted, mapping bug patched, bad tenant data corrected):

1. Mark affected `clearance_outbox` rows with status back to `queued` and `attempts = 0`:

   ```sql
   UPDATE clearance_outbox
   SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL
   WHERE id = ANY(:ids);
   ```

2. Trigger `POST /clearance/drain`.
3. Watch the `rejected` rate — it should fall off within one drain cycle.

## Root-cause history (template)

- **Date (UTC):**
- **Dominant reason_code(s):**
- **Blast radius:** tenants, invoices, revenue delayed.
- **Root cause:**
- **What we did:**
- **Follow-ups:**

## Links

- `docs/runbooks/data-dictionary-update.md` — when the fault is a stale rule pack.
- `packages/compliance/src/pint-om/` — PINT-OM specialisation code.
- `apps/api/src/modules/clearance/clearance-events.service.ts` — append-only audit trail.

---

Last updated: 2026-10-17
Author: <on-call-sre>
