/**
 * Platform status events — public status-page projection of inbound
 * PagerDuty webhook deliveries.
 *
 * Every verified V3 PagerDuty event that reaches
 * POST /api/webhooks/pagerduty is appended here by PlatformStatusService,
 * so a future status-page UI can render an incident timeline without
 * re-hitting PagerDuty.
 *
 * ──────────────────── Why RLS is deliberately OFF ────────────────────
 * Every other table in Faatora is RLS-isolated by tenant_id or firm_id.
 * This one intentionally is not.
 *
 *   1. The point of a public status page is that EVERYONE sees the same
 *      incident timeline — a logged-out visitor, a tenant customer, a
 *      firm's partner. There is no tenant to scope to.
 *   2. The reader of this table will be a public controller that runs
 *      with the app role and no app.tenant_id / app.firm_id set. An
 *      RLS policy keyed on either would simply block every read.
 *   3. Per-tenant fan-out (showing a tenant's own status board when
 *      "their" service is degraded) happens over the EventEmitter2
 *      `platform.status.event` topic that PlatformStatusService emits
 *      alongside the INSERT, NOT via an RLS-gated SELECT on this table.
 *
 * Writes are still restricted at the app layer: only the signature-
 * verified PagerDuty controller calls PlatformStatusService.record(),
 * and GRANT on the table is scoped to the app role.
 *
 * ──────────────────── Shape ────────────────────
 *   incident_id     TEXT  — PagerDuty incident id (event.data.id)
 *   pd_event_type   TEXT  — raw inbound event type, e.g. `incident.triggered`
 *   status          TEXT  — human-facing phase projected from pd_event_type
 *                           (investigating | identified | monitoring | resolved)
 *   summary         TEXT  — event.data.summary when PagerDuty supplies one
 *   occurred_at     TSTZ  — event.occurred_at (PD's clock)
 *   received_at     TSTZ  — our wall-clock at ingestion
 *   raw_payload     JSONB — full event envelope for future enrichment / debug
 *
 * Indexes:
 *   platform_status_events_incident_idx (incident_id, occurred_at DESC) —
 *     the status page renders "latest state for this incident" from here.
 *   platform_status_events_received_at_idx (received_at DESC) —
 *     operational "what came in in the last hour?" queries.
 *
 * Idempotent-ish: uses CREATE TABLE / INDEX IF NOT EXISTS so a re-run
 * against a DB that already has the objects is a no-op. Reversible via
 * DROP TABLE in `down`.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS platform_status_events (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      incident_id     TEXT NOT NULL,
      pd_event_type   TEXT NOT NULL,
      status          TEXT NOT NULL,
      summary         TEXT,
      occurred_at     TIMESTAMPTZ NOT NULL,
      received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      raw_payload     JSONB NOT NULL
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS platform_status_events_incident_idx
      ON platform_status_events (incident_id, occurred_at DESC);
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS platform_status_events_received_at_idx
      ON platform_status_events (received_at DESC);
  `);

  // Writes are driven by the PagerDuty controller running under the app
  // role. RLS is intentionally left OFF — see the file header for why.
  pgm.sql(`GRANT SELECT, INSERT ON platform_status_events TO faatora_app;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS platform_status_events;`);
};
