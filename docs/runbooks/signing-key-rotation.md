# Runbook — Signing key rotation

**Severity:** Planned maintenance (not an incident) — but a botched rotation turns into a P0 ("invoices sign but ASP rejects signature" → every invoice issued during the rotation window is retroactively suspect). Treat the rollout with the care of a schema migration.

## When to rotate

- **Scheduled.** Every 365 days per key policy.
- **Reactive.** On suspected compromise, HSM/KMS vendor advisory, or when the chain-of-trust certificate used by the OTA is updated.

## Pre-rotation checklist

1. Confirm the **new key** is already generated in the HSM/KMS region and reachable from the API's role. For local dev the equivalent is a new PEM in `apps/api/.env` under `SIGNING_PRIVATE_KEY_V2`.
2. Confirm the **public key for the new key** is registered with the ASP / OTA trust store. The ASP's public-key list endpoint should include the new key's SHA-256 fingerprint — grep for it.
3. Dashboard open: `faatora_signing_total{result="success|error"}` and `faatora_clearance_submissions_total{result="rejected"}` with `reason_code=~"signature.*"`.
4. Freeze non-signing migrations for the window (any migration that locks `invoices` is a bad neighbour here).
5. Announce in `#status-faatora`: "Signing key rotation in flight. Dual-sign window starts _T_, ends _T+2h_."

## Dual-signing window (recommended)

The rotation is **not** a hard switchover. We run a window — typically 2 hours — where the signer emits BOTH signatures (old key as primary, new key as secondary header) so a buyer or auditor fetching the invoice can verify under either public key. The OTA verifies the primary. The sequence:

| Phase | Primary key | Secondary key | What verifies |
|-------|-------------|---------------|---------------|
| Normal | V1 | — | V1 |
| Dual-sign | V1 | V2 | V1 or V2 |
| Switchover | V2 | V1 | V1 or V2 |
| Normal | V2 | — | V2 |

Configuration knob: `SIGNING_ACTIVE_KEY_ID` (promotes primary) and `SIGNING_FALLBACK_KEY_ID` (writes secondary signature when set). Flip in order: enter dual-sign → switch primary → exit dual-sign.

## Verification during rotation

Every 10 minutes during the window:

```sql
-- Pull a random sample of invoices issued in the last 10 minutes:
SELECT id, number, signing_key_id, signed_at
FROM invoices
WHERE signed_at > now() - interval '10 minutes'
ORDER BY random()
LIMIT 10;
```

For each, call `GET /invoices/:id/verify-signature?key=all` which runs the stored signed payload through BOTH current public keys and asserts at least one verifies.

## Rollback

If `faatora_signing_total{result="error"}` jumps or ASP rejections for signature reasons appear:

1. Revert `SIGNING_ACTIVE_KEY_ID` to the previous value.
2. Keep dual-sign mode on until the issue is diagnosed.
3. Any invoice issued under the suspect primary needs re-signing under the previous primary (new `clearance_outbox` row via replay) — do this per-invoice, do NOT bulk re-sign (an audit trail of re-signs is required).

## Post-rotation

1. Keep V1 as `SIGNING_FALLBACK_KEY_ID` for 90 days (buyers may still request original PDF with original signature).
2. After 90 days, retire V1 — remove from signer config AND from the ASP/OTA trust store.
3. Record completion in `docs/adr/` with the fingerprints.

## Root-cause history (template, if rotation went wrong)

- **Date (UTC):**
- **Phase that broke:**
- **Invoices mis-signed:**
- **Recovery steps:**
- **Follow-ups:**

## Links

- `apps/api/src/modules/signing/` — signer code.
- `docs/sla.md` — the signing-path SLO.
- `docs/runbooks/clearance-rejections-spike.md` — if rejections start piling up with signature-related reason codes.

---

Last updated: 2026-10-17
Author: <on-call-sre>
