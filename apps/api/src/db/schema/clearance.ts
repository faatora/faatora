import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { invoices } from './invoicing';

/**
 * Transactional outbox: every signed invoice emits exactly one row here
 * inside the same transaction that flips the invoice state to SUBMITTED,
 * so no committed invoice is ever lost on the way to the ASP.
 *
 * The unique constraint on idempotency_key is what makes enqueue()
 * safely retryable — it's a hard database-enforced idempotency guard.
 */
export const clearanceOutbox = pgTable(
  'clearance_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payloadSha256: text('payload_sha256').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusNextIdx: index('clearance_outbox_tenant_status_next_idx').on(
      t.tenantId,
      t.status,
      t.nextAttemptAt,
    ),
    statusNextIdx: index('clearance_outbox_status_next_idx').on(t.status, t.nextAttemptAt),
  }),
);

/**
 * Append-only state-machine audit log. Every transition in
 * DRAFT -> VALIDATED -> SIGNED -> SUBMITTED -> CLEARED | REJECTED -> ARCHIVED
 * is journaled here so an auditor can reconstruct the full timeline of a
 * document without reading operational state.
 */
export const clearanceEvents = pgTable(
  'clearance_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    actor: text('actor').notNull(),
    aspReference: text('asp_reference'),
    otaReference: text('ota_reference'),
    rawResponse: jsonb('raw_response'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantInvoiceAtIdx: index('clearance_events_tenant_invoice_at_idx').on(
      t.tenantId,
      t.invoiceId,
      t.at,
    ),
  }),
);

/**
 * Dead-letter queue. An outbox row that fails more than N attempts is moved
 * here with its last error and the payload it was trying to deliver, so an
 * operator can inspect and manually re-queue it later.
 */
export const clearanceDlq = pgTable(
  'clearance_dlq',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    outboxId: uuid('outbox_id'),
    error: text('error').notNull(),
    attempts: integer('attempts').notNull(),
    sentPayload: jsonb('sent_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('clearance_dlq_tenant_created_idx').on(t.tenantId, t.createdAt),
  }),
);
