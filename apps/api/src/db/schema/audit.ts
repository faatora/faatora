/**
 * EP5 Wave 2 (W2-E) — firm-scoped audit log schema.
 *
 * Narrow table + jsonb payload. Payload shape is per event_type and
 * owned by AuditService's subscribers (apps/api/src/modules/audit/).
 * Migration 1710001600000_firm_audit_events.cjs owns DDL + RLS; this
 * file only gives Drizzle a typed view.
 */
import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { firms } from './firms';
import { tenants, users } from './tenancy';

export const firmAuditEvents = pgTable(
  'firm_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('system'),
  },
  (t) => ({
    firmTimeIdx: index('firm_audit_events_firm_time_idx').on(t.firmId, t.occurredAt),
    typeIdx: index('firm_audit_events_type_idx').on(t.eventType),
  }),
);

export type FirmAuditEventRow = typeof firmAuditEvents.$inferSelect;
