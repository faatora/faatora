import { pgTable, uuid, text, timestamp, date, bigint, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
 *     (`prev_sha256`, null for the first row of the tenant),
 *   - `chain_hash` = sha256((prev_sha256 ?? '') + '|' + sha256) in hex,
 *   - `retention_tier` — the current S3 storage class for the object
 *     (STANDARD for year 0-5, GLACIER_IR for year 5-10), and
 *   - `retention_until_at` — the point-in-time deletion is permitted at
 *     (archived_at + 10 years, matching the Lifecycle Expiration rule
 *     and the per-object Object Lock retain-until date).
 *
 * The chain is per-tenant: each tenant's rows form an independent chain
 * ordered by `archived_at`. Verification recomputes `chain_hash` from
 * `prev_sha256` and `sha256`, so any after-the-fact tampering with a row's
 * `sha256` surfaces at that row during `verifyChain`.
 *
 * Rows are RLS-isolated by `tenant_id` and the unique (tenant_id, invoice_id)
 * constraint guarantees one archive entry per invoice (immutability on the
 * database side; the filesystem backend also enforces this with mode 0o400).
 *
 * OTA rule implemented: Fawtara §5.7 — 10-year retention (5 years
 * operational + 5 years cold archive).
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
    // 10-year retention tracking (migration 1710002200000_archive_retention_tier).
    // STANDARD = hot (year 0-5, S3 Standard), GLACIER_IR = cold (year 5-10,
    // Glacier Instant Retrieval). The tier the service STAMPS at write time
    // is always STANDARD; the S3 Lifecycle rule in infra/modules/archive/
    // transitions the object class in-place at day 1825 and a periodic job
    // reconciles archive_records.retention_tier against the actual class.
    retentionTier: text('retention_tier').notNull().default('STANDARD'),
    retentionUntilAt: timestamp('retention_until_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '10 years'`),
  },
  (t) => ({
    tenantIdx: index('archive_records_tenant_idx').on(t.tenantId),
    invoiceIdx: index('archive_records_invoice_idx').on(t.invoiceId),
    documentUuidIdx: index('archive_records_doc_uuid_idx').on(t.documentUuid),
    tenantArchivedIdx: index('archive_records_tenant_archived_idx').on(t.tenantId, t.archivedAt),
    tenantInvoiceUniq: unique('archive_records_tenant_invoice_uniq').on(t.tenantId, t.invoiceId),
    tenantTierIdx: index('archive_records_tenant_tier_idx').on(t.tenantId, t.retentionTier),
    retentionUntilIdx: index('archive_records_retention_until_idx').on(t.retentionUntilAt),
  }),
);

/**
 * The two retention tiers an archive object can be in. STANDARD is the
 * normal S3 class the object lives in for the first 5 years. GLACIER_IR
 * is Glacier Instant Retrieval — still a synchronous GetObject (no restore
 * step), but ~2x the per-GET cost. See apps/api/src/modules/archive/
 * glacier-reader.ts for the cost note.
 */
export type ArchiveRetentionTier = 'STANDARD' | 'GLACIER_IR';

/**
 * Operational-tier cutoff. After this many days from archived_at the S3
 * Lifecycle rule moves the object to GLACIER_IR and ArchiveService stamps
 * retention_tier accordingly. Mirrors infra/modules/archive/variables.tf's
 * `glacier_ir_transition_days` default so the application layer agrees
 * with the bucket's rule.
 */
export const GLACIER_IR_TRANSITION_DAYS = 1825; // 5 years
/**
 * Expiration cutoff. S3 Lifecycle deletes the object; ArchiveService
 * refuses reads that would otherwise land on a since-deleted key.
 * Mirrors infra/modules/archive/variables.tf's `expiration_days` default.
 */
export const RETENTION_EXPIRATION_DAYS = 3650; // 10 years
