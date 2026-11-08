# Runbook — Clearance DLQ filling

**Severity:** Page (P1) — a non-zero DLQ means at least one invoice has terminally failed clearance. For a tier-0 compliance product that is a reportable event.

## Symptoms

- `fawtara_clearance_dlq_size > 0` — the gauge is zero when the DLQ table is empty, so any non-zero value fires.
- Fast fill: `increase(fawtara_clearance_dlq_size[10m]) > 5` means multiple invoices failed within a short window — usually a systemic issue, not individual bad data.

## Detection

- **Alert rule.**
  - P1: `fawtara_clearance_dlq_size > 0 for 5m`.
  - P1 fast-fill: `increase(fawtara_clearance_dlq_size[10m]) > 5`.
- **Log signal.** Pino lines with `event=clearance.dlq.insert`, carrying `invoice_id`, `outbox_id`, `attempts`, `error`.

## Triage flowchart

```
                           +-----------------------------+
                           |  fawtara_clearance_dlq_size |
                           |          non-zero           |
                           +--------------+--------------+
                                          |
                   +----------------------+----------------------+
                   |                                             |
         single invoice                                  multiple invoices
                   |                                             |
         inspect error field                           same error for all?
                   |                                             |
    tenant-specific data issue                       yes → systemic (ASP / mapping)
         -> contact tenant                            no  → mixed → inspect each
         -> optional replay once fixed
```

## Inspection SQL

Run against the migration-role connection (RLS-bypassing):

```sql
-- All DLQ rows, newest first:
SELECT id, tenant_id, invoice_id, attempts, error, created_at
FROM clearance_dlq
ORDER BY created_at DESC
LIMIT 50;

-- Distribution by error substring:
SELECT substr(error, 1, 80) AS err, COUNT(*) AS n
FROM clearance_dlq
GROUP BY err
ORDER BY n DESC;

-- Correlate with the sent payload:
SELECT invoice_id, sent_payload, error
FROM clearance_dlq
WHERE id = :dlq_id;
```

## When to replay vs delete

- **Replay** if the root cause has been remediated AND the invoice is still legally due (within statute of limitations and not superseded by a credit note). Replay path:

  ```sql
  BEGIN;
  INSERT INTO clearance_outbox (id, tenant_id, invoice_id, idempotency_key, payload_sha256, status, attempts, next_attempt_at)
  SELECT gen_random_uuid(), tenant_id, invoice_id, 'replay-' || id::text, payload_sha256, 'queued', 0, now()
  FROM clearance_dlq
  WHERE id = :dlq_id;

  DELETE FROM clearance_dlq WHERE id = :dlq_id;
  COMMIT;
  ```

  Then `POST /clearance/drain`.

- **Delete** only if the invoice was voided out-of-band by the tenant and OTA already acknowledged a credit note. Record the reason in `clearance_events` with `actor='user'` before deleting the DLQ row.

- **NEVER** silently delete a DLQ row without a credit-note trail — the tier-0 audit path requires every original invoice to end in `delivered` or an explicit void.

## Investigation steps

1. Does the `error` field match a known ASP fault? Cross-reference `docs/runbooks/clearance-rejections-spike.md`.
2. Were these invoices all signed under a key that's since been rotated? Check `signing_key_id` on the invoice row vs the current active key — see `docs/runbooks/signing-key-rotation.md`.
3. Is there a backlog of `in_flight` rows older than 1 hour that should have moved to `delivered`? That points at a drain worker crash before the ASP callback could land.

## Root-cause history (template)

- **Date (UTC):**
- **DLQ depth at peak:**
- **Invoices affected:** tenant_ids and counts.
- **Root cause:**
- **Replayed / deleted:** which rows, who approved.
- **Follow-ups:**

## Links

- `docs/runbooks/clearance-asp-down.md` — if the DLQ filled during an ASP outage.
- `docs/runbooks/clearance-rejections-spike.md` — if the DLQ is filling with "rejected" terminal errors.
- `apps/api/migrations/1710001000000_clearance.cjs` — schema reference.

---

Last updated: 2026-10-17
Author: <on-call-sre>
