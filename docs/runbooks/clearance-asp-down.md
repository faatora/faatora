# Runbook — Clearance ASP outage

**Severity:** Page (P1) — tier-0 compliance path is down.

## Symptoms

- `fawtara_clearance_submissions_total{result="error"}` climbing fast.
- `fawtara_clearance_queue_depth{status="queued"}` climbing linearly (drain can't keep up because every submission errors).
- API p95 latency on `POST /invoices/:id/issue` normal (we don't block issue on clearance — the outbox absorbs).
- Customer tickets reporting "cleared status not updating".
- ASP-side status page reporting degraded, or no inbound TCP to ASP endpoint from the API's egress subnet.

## Detection

- **Alert rule.** `increase(fawtara_clearance_submissions_total{result="error"}[5m]) > 20` AND `fawtara_clearance_queue_depth{status="queued"} > 100`.
- **Log signal.** Pino lines with `event=clearance.submission.error` and `asp_endpoint_timeout` or `asp_endpoint_5xx` cause codes.
- **Correlation.** Pick a sample `invoice_id` from the error logs and trace the full submission chain by its `correlation_id`.

## Immediate mitigation

1. **Confirm the ASP is actually down.**
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://asp.example.om/health` from a bastion in the API's VPC.
   - Check the ASP vendor status page (link in on-call wiki).
2. **Flip the circuit breaker to open.** This stops burning retries at the ASP and lets the outbox hold rows at `queued` without crawling the next-attempt-at exponential backoff.
   - `POST /ops/clearance/breaker` with `{ "state": "open", "reason": "ASP outage", "ttl_minutes": 30 }`.
3. **Announce in `#status-fawtara`:** "Clearance submission paused: ASP outage, queue absorbs — expect catch-up on recovery."
4. **If outage > 15 minutes:** page the vendor's on-call via the agreed phone bridge.

## Investigation steps

1. Check `fawtara_clearance_latency_seconds` just before the spike started — a slow climb in latency often precedes a hard failure (connection pool exhaustion, TLS renegotiation storm).
2. Pull the last 10 `clearance_events` rows: `SELECT * FROM clearance_events ORDER BY at DESC LIMIT 10;` (migration role) — the `raw_response` jsonb carries the ASP's last words.
3. Look at the API's egress proxy logs for the ASP hostname — a sudden spike of `aborted` or `connection reset` points at the network path, not the ASP app.

## Recovery

1. **ASP recovers.** Flip the breaker to `half-open` for 5 minutes; a sample set of in-flight rows will be tried. If success rate ≥ 95%, close the breaker.
2. **Drain the backlog.** Manual: `POST /clearance/drain` — the drain respects the breaker and spreads retries across the full tenant set to avoid stampede.
3. **Watch** `fawtara_clearance_queue_depth{status="queued"}` ride back down. Expect ~X submissions/minute given current ASP throughput.
4. **DO NOT replay DLQ rows yet.** If any landed in DLQ during the outage (`attempts >= max`), route them through `docs/runbooks/dlq-filling.md` after primary queue is empty.

## Root-cause history (template)

- **Date (UTC):**
- **Duration (page → mitigated):**
- **Impact:** _N_ tenants, _N_ invoices delayed, longest delay _N_ minutes.
- **Root cause:**
- **What we did:**
- **Follow-ups:** PRs, config changes, alert tuning.

## Links

- `docs/sla.md` — the SLO this incident ate into.
- `apps/api/src/modules/clearance/` — gateway service code.
- `docs/runbooks/dlq-filling.md` — follow-up triage for anything that landed in DLQ.

---

Last updated: 2026-10-17
Author: <on-call-sre>
