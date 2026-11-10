/**
 * Drizzle schema for billing webhook idempotency.
 *
 * One row per provider event we have ever seen. The UNIQUE on
 * (provider, provider_event_id) is what makes replay safe: inserts
 * conflict silently and the handler short-circuits. `processed_at`
 * is stamped only after the business-side handler returns. A row
 * with `processed_at IS NULL` is either still running or crashed
 * mid-flight and is safe to retry.
 *
 * This schema is re-exported from `db/schema/firm-billing.ts` so the
 * global Drizzle schema sees it and migrations keep the one-source
 * convention used elsewhere in the project.
 */
import { pgTable, uuid, text, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';

export const billingWebhookEvents = pgTable(
  'billing_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    payload: jsonb('payload').notNull(),
  },
  (t) => ({
    providerEventUniq: unique('billing_webhook_events_provider_event_uniq').on(
      t.provider,
      t.providerEventId,
    ),
    typeIdx: index('billing_webhook_events_type_idx').on(t.eventType),
  }),
);

export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect;
