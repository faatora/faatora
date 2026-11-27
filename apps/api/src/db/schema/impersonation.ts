/**
 * Drizzle typed view of firm_impersonation_events.
 *
 * Backing DDL + RLS live in migration 1710002400000_impersonation_events.cjs.
 * See that file (and docs/runbooks/accountant-impersonation.md) for the
 * why.
 *
 * The table is read on the hot path by TenantGuard whenever a request
 * carries `X-Impersonate-Tenant-Id`, so the three indexes defined in the
 * migration are the ones the schema's queries rely on:
 *   - firm_impersonation_events_firm_idx     (firm_id, started_at DESC)
 *   - firm_impersonation_events_tenant_idx   (client_tenant_id, started_at DESC)
 *   - firm_impersonation_events_active_idx   (firm_id, client_tenant_id) WHERE ended_at IS NULL
 */
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { firms } from './firms';
import { tenants, users } from './tenancy';

export const IMPERSONATION_END_REASONS = ['expired', 'user_exited', 'revoked'] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

export const firmImpersonationEvents = pgTable(
  'firm_impersonation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientTenantId: uuid('client_tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    firmIdx: index('firm_impersonation_events_firm_idx').on(t.firmId, t.startedAt),
    tenantIdx: index('firm_impersonation_events_tenant_idx').on(t.clientTenantId, t.startedAt),
    // Partial index — matches the migration. Drizzle serialises the
    // predicate so the generated migration diff stays aligned if a future
    // tooling pass regenerates from the schema. ended_at IS NULL (not
    // "expires_at > now()") because expiry is enforced in the app layer;
    // keeping the index tight on "not yet torn down" rows means TenantGuard's
    // hot-path lookup stays a single index hit.
    activeIdx: index('firm_impersonation_events_active_idx')
      .on(t.firmId, t.clientTenantId)
      .where(sql`ended_at IS NULL`),
  }),
);

export type FirmImpersonationEventRow = typeof firmImpersonationEvents.$inferSelect;
