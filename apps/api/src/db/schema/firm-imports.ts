/**
 * EP5 Wave 2 (W2-D) — firm-scoped import tables.
 *
 * `import_column_mappings` holds per-firm overrides of the default
 * column mapping for a given source_format. `import_batches` records
 * each committed import so re-uploads of the same file can skip rows
 * whose content hash is already seen for that client tenant.
 *
 * RLS: `import_column_mappings` is firm-scoped (keyed on app.firm_id).
 * `import_batches` is tenant-scoped (keyed on app.tenant_id) because
 * the batch's rows live under the client tenant's RLS namespace, same
 * as the invoices they produced.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { firms } from './firms';
import { tenants } from './tenancy';

export const importColumnMappings = pgTable(
  'import_column_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    sourceFormat: text('source_format').notNull(),
    mappingJson: jsonb('mapping_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmFormatIdx: index('import_column_mappings_firm_format_idx').on(t.firmId, t.sourceFormat),
    firmFormatUniq: uniqueIndex('import_column_mappings_firm_format_uniq').on(
      t.firmId,
      t.sourceFormat,
    ),
  }),
);

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceFormat: text('source_format').notNull(),
    filename: text('filename'),
    rowCountTotal: integer('row_count_total').notNull().default(0),
    rowCountCommitted: integer('row_count_committed').notNull().default(0),
    rowCountSkipped: integer('row_count_skipped').notNull().default(0),
    rowCountErrored: integer('row_count_errored').notNull().default(0),
    rowHashes: jsonb('row_hashes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('import_batches_tenant_created_idx').on(t.tenantId, t.createdAt),
    firmIdx: index('import_batches_firm_idx').on(t.firmId),
  }),
);
