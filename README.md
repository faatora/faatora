# Faatora

Multi-tenant Oman e-invoicing SaaS (OTA Fawtara / Peppol PINT-OM).

## Operations

Faatora is a tier-0 compliance product; the API is instrumented end-to-end so an SRE at 3 AM can tell what's wrong from Prometheus + logs alone.

### Metrics endpoint

- `GET /metrics` on each API node returns Prometheus exposition-format metrics (text/plain; version=0.0.4).
- The endpoint is intentionally unauthenticated — the response contains only aggregate counters, histograms, and gauges, with no PII and only opaque `tenant_id` labels. **In production, restrict `/metrics` at the network layer** to the Prometheus scraper's security group / CIDR, either on the ALB or on an in-cluster service mesh policy. See `apps/api/src/common/observability/metrics.controller.ts`.
- Metric families emitted:
  - `faatora_http_requests_total`, `faatora_http_request_duration_seconds` — request-level RED metrics.
  - `faatora_invoice_issued_total`, `faatora_signing_total` — business counters.
  - `faatora_clearance_submissions_total`, `faatora_clearance_latency_seconds`, `faatora_clearance_rejection_reason_total`, `faatora_clearance_queue_depth`, `faatora_clearance_dlq_size` — the clearance pipeline.
  - `faatora_canary_last_success_timestamp` — synthetic end-to-end canary (fires every 60 s, validates the compliance core + DB).
  - `faatora_node_*` — default Node process / event-loop metrics.

### Pointing Prometheus / Grafana at the service

A minimal `prometheus.yml` scrape config:

```yaml
scrape_configs:
  - job_name: faatora-api
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ['faatora-api.internal:3000']
```

For Grafana, point a Prometheus data source at that scrape target and import the dashboards tracked under `docs/sla.md`. The dashboards expected to exist are: platform overview, clearance pipeline, tenant quality, and signing.

### Alerting

Alerts are delivered through a swappable sink (`AlertSink` port, `ALERT_SINK` DI token). The default is `LogAlertSink` (writes through the Nest/pino logger with severity-mapped levels). For production, bind `WebhookAlertSink` in `apps/api/src/common/observability/observability.module.ts` and set:

```bash
export FAATORA_ALERT_WEBHOOK=https://api.opsgenie.com/v2/alerts  # or PagerDuty, or a Slack Incoming Webhook
```

The webhook sink POSTs a JSON envelope `{ severity, title, details, source, emitted_at }`. If `FAATORA_ALERT_WEBHOOK` is unset the sink is a logged no-op (so a mis-provisioned environment is loud, not crashing).

### Runbooks

Operational runbooks live under `docs/runbooks/`. The current set:

- [`clearance-asp-down.md`](docs/runbooks/clearance-asp-down.md) — ASP outage response, circuit-breaker usage, manual drain.
- [`clearance-rejections-spike.md`](docs/runbooks/clearance-rejections-spike.md) — reason-code drill-down and replay flow.
- [`dlq-filling.md`](docs/runbooks/dlq-filling.md) — DLQ triage, replay vs delete decisioning.
- [`signing-key-rotation.md`](docs/runbooks/signing-key-rotation.md) — KMS/local key rotation with a dual-sign window.
- [`data-dictionary-update.md`](docs/runbooks/data-dictionary-update.md) — PINT-OM rule-pack bump procedure.

The SLOs these runbooks defend are declared in [`docs/sla.md`](docs/sla.md).
