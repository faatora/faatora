# Fawtara — Service Level Objectives

These SLOs are the commitments the Fawtara platform makes to its tenants and to the OTA. They are measured against a rolling 30-day window and reviewed monthly.

## Platform availability

**Target: 99.9% monthly availability.**

Availability is measured as the fraction of successful `/health` checks over total `/health` checks per 1-minute bucket, aggregated across all Fawtara API nodes behind the load balancer.

- 99.9% monthly ≈ 43 min 50 s of downtime budget per 30-day window.
- Burn-rate alert at 10x normal fires on `page` to on-call.

## Clearance submission path (tier-0)

**Target: 99.95% monthly success rate.**

A clearance submission is counted as **successful** when a `clearance_outbox` row transitions to `delivered` within the retry policy's bounded time. Rejections caused by the tenant's own data (invalid VAT ID, malformed line) are counted toward tenant quality metrics, not against this SLO. Everything else — our bugs, ASP outages beyond the agreed vendor SLA, infra failures — counts.

- 99.95% monthly ≈ 21 min 54 s of eligible failure budget per 30-day window.
- Measured on `rate(fawtara_clearance_submissions_total{result="delivered"}) / rate(fawtara_clearance_submissions_total)`.

## Clearance submission latency

**Target: p95 < 10 s when ASP is healthy.**

End-to-end latency from `/invoices/:id/issue` acknowledgement to a terminal `delivered` state in `clearance_outbox`. "ASP healthy" means the vendor's own SLO page reports green for the window.

- Measured on `histogram_quantile(0.95, fawtara_clearance_latency_seconds_bucket)`.

## Alert MTT-ack and MTT-mitigate

- **MTT-ack (page):** 15 minutes. From alert fire to a human acknowledging it in the pager tool.
- **MTT-mitigate:** 60 minutes. From alert fire to a visible green on the primary dashboard.

If either number is breached for two consecutive incidents, the SRE on-call rotation is reviewed and the alert itself is re-tuned.

## Archive durability

**Target: 11 nines (99.999999999%) object durability.**

Signed invoices and their XML / PDF renderings are stored in object storage with cross-region replication. The 11-nines figure is the storage vendor's baseline; our contract adds versioning + object lock so an accidental delete or ransomware event cannot destroy the archive within the retention window.

## Archive retention

**Target: 10 years.**

OTA regulatory requirement. Objects are protected by object-lock in compliance mode for the full 10 years. Deletes are not supported, including for the operator. Expiry is managed by lifecycle policy.

## Dashboards (placeholders)

- Platform overview: `https://grafana.fawtara.om/d/platform-overview` *(TBD)*
- Clearance pipeline: `https://grafana.fawtara.om/d/clearance` *(TBD)*
- Tenant quality: `https://grafana.fawtara.om/d/tenant-quality` *(TBD)*
- Signing: `https://grafana.fawtara.om/d/signing` *(TBD)*

## Alert channels (placeholders)

- Page: Opsgenie / PagerDuty via `FAWTARA_ALERT_WEBHOOK`.
- Chat: `#ops-fawtara` Slack channel for `warn` severities.
- Journal: `info` severities route to CloudWatch Logs only.

---

Last updated: 2026-10-17
Owner: SRE
