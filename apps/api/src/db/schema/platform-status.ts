/**
 * Platform status events — the persistence layer behind the public
 * status page.
 *
 * Every verified PagerDuty webhook delivery is projected into one row
 * here so a future (very thin) status-page UI can render an incident
 * timeline without re-reading PagerDuty. The table is append-only;
 * the status column is the human-facing phase that maps 1:1 from the
 * inbound `pd_event_type` (see mapToStatus in platform-status.service.ts).
 *
 * NOT tenant-scoped. This table exists specifically so a public URL
 * can read it without any logged-in session. RLS is deliberately OFF
 * on the backing table (see migration 1710002300000) — the whole
 * point of a public status page is that everyone sees the same
 * timeline, so there is no tenant to scope to. Per-tenant notification
 * fan-out happens over `platform.status.event` on EventEmitter2, not
 * via a RLS-gated SELECT.
 *
 * `raw_payload` captures the full PagerDuty event envelope so we can
 * add columns later (incident severity, service name, …) without
 * re-fetching from PagerDuty.
 */
import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const platformStatusEvents = pgTable(
  'platform_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** PagerDuty's incident id — `event.data.id` on the V3 payload. */
    incidentId: text('incident_id').notNull(),
    /** Raw PagerDuty event type, e.g. `incident.triggered`. */
    pdEventType: text('pd_event_type').notNull(),
    /** Human-facing phase: investigating | identified | monitoring | resolved. */
    status: text('status').notNull(),
    /** `event.data.summary` on the V3 payload, if present. */
    summary: text('summary'),
    /** `event.occurred_at` as reported by PagerDuty. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Wall-clock when the webhook landed on our side. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Full inbound event for future columns / debugging. */
    rawPayload: jsonb('raw_payload').notNull(),
  },
  (t) => ({
    incidentIdx: index('platform_status_events_incident_idx').on(t.incidentId, t.occurredAt),
    receivedIdx: index('platform_status_events_received_at_idx').on(t.receivedAt),
  }),
);

export type PlatformStatusEventRow = typeof platformStatusEvents.$inferSelect;
export type PlatformStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
