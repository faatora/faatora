import { pgTable, uuid, text, timestamp, date, bigint, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { invoices } from './invoicing';
import { signedDocuments } from './signing';

/**
 * Tamper-evident archive of signed invoices.
 *
 * Each row stores:
 *   - the storage pointer to the signed payload (filesystem path in dev/CI,
 *     S3 key in production — the backend is identified by `storage_backend`),
 *   - the SHA-256 digest of the payload (`sha256`),
 *   - the SHA-256 of the PREVIOUS archive row for the same tenant
 *     (`prev_sha256`, null for the first row of the tenant), and
 *   - `chain_hash` = sha256((prev_sha256 ?? '') + '|' + sha256) in hex.
 *
 * The chain is per-tenant: each tenant's rows form an independent chain
 * ordered by `archived_at`. Verification recomputes `chain_hash` from
 * `prev_sha256` and `sha256`, so any after-the-fact tampering with a row's
 * `sha256` surfaces at that row during `verifyChain`.
 *
 * Rows are RLS-isolated by `tenant_id` and the unique (tenant_id, invoice_id)
 * constraint guarantees one archive entry per invoice (immutability on the
 * database side; the filesystem backend also enforces this with mode 0o400).
 */
export const archiveRecords = pgTable(
  'archive_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    signedDocumentId: uuid('signed_document_id')
      .notNull()
      .references(() => signedDocuments.id),
    documentUuid: text('document_uuid').notNull(),
    storageBackend: text('storage_backend').notNull(),
    storageKey: text('storage_key').notNull(),
    storageBucket: text('storage_bucket'),
    storageRegion: text('storage_region'),
    sha256: text('sha256').notNull(),
    prevSha256: text('prev_sha256'),
    chainHash: text('chain_hash').notNull(),
    contentType: text('content_type').notNull().default('application/xml'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    retentionUntil: date('retention_until').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('archive_records_tenant_idx').on(t.tenantId),
    invoiceIdx: index('archive_records_invoice_idx').on(t.invoiceId),
    documentUuidIdx: index('archive_records_doc_uuid_idx').on(t.documentUuid),
    tenantArchivedIdx: index('archive_records_tenant_archived_idx').on(t.tenantId, t.archivedAt),
    tenantInvoiceUniq: unique('archive_records_tenant_invoice_uniq').on(t.tenantId, t.invoiceId),
  }),
);
