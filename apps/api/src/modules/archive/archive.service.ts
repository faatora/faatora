import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, between, desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { invoices } from '../../db/schema/invoicing';
import { signedDocuments } from '../../db/schema/signing';
import {
  archiveRecords,
  GLACIER_IR_TRANSITION_DAYS,
  RETENTION_EXPIRATION_DAYS,
  type ArchiveRetentionTier,
} from '../../db/schema/archive';
import { ARCHIVE_STORAGE, type ArchiveStorage } from './storage.port';
import { computeChainHash, sha256Hex } from './hash-chain';

export interface ArchiveRecordRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  signedDocumentId: string;
  documentUuid: string;
  storageBackend: 'filesystem' | 's3';
  storageKey: string;
  storageBucket: string | null;
  storageRegion: string | null;
  sha256: string;
  prevSha256: string | null;
  chainHash: string;
  contentType: string;
  byteSize: number;
  retentionUntil: string;
  archivedAt: Date;
  retentionTier: ArchiveRetentionTier;
  retentionUntilAt: Date;
}

export interface ArchiveSkip {
  skipped: true;
  reason: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  breakAt?: string;
  breakReason?: string;
}

const RETENTION_YEARS = 10;

function retentionUntilFrom(now: Date): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Decide which S3 storage class an object should be in given its
 * archived_at and the clock. New writes always land in STANDARD (the S3
 * Lifecycle rule in infra/modules/archive/main.tf does the actual
 * transition at day 1825); the periodic reconcile job uses this same
 * function to catch up archive_records.retention_tier with the bucket.
 *
 * OTA rule implemented: Fawtara §5.7 — 5 years operational + 5 years
 * cold archive = 10 years total.
 */
export function expectedTierFor(archivedAt: Date, now: Date = new Date()): ArchiveRetentionTier {
  const ageDays = (now.getTime() - archivedAt.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays < GLACIER_IR_TRANSITION_DAYS ? 'STANDARD' : 'GLACIER_IR';
}

/**
 * Compute the point-in-time past which the Lifecycle rule will have
 * expired the object and reads should refuse rather than return a 404
 * from S3. Mirrors infra/modules/archive/variables.tf's `expiration_days`.
 */
export function retentionUntilAtFrom(archivedAt: Date): Date {
  return new Date(archivedAt.getTime() + RETENTION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
}

@Injectable()
export class ArchiveService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ARCHIVE_STORAGE) private readonly storage: ArchiveStorage,
  ) {}

  /**
   * Archive one CLEARED invoice.
   *
   * On success, returns the inserted `archive_records` row and transitions
   * the invoice to ARCHIVED. If the invoice is not CLEARED, returns a skip
   * reason instead of throwing — makes the method safe to retry and safe
   * for a future "auto-trigger on CLEARED" hook from A14's gateway.
   */
  async archiveInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<ArchiveRecordRow | ArchiveSkip> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'CLEARED') {
        return {
          skipped: true as const,
          reason: `invoice status is ${invoice.status}, expected CLEARED`,
        };
      }

      const [signed] = await tx
        .select()
        .from(signedDocuments)
        .where(eq(signedDocuments.invoiceId, invoiceId))
        .limit(1);
      if (!signed) {
        throw new BadRequestException('No signed_documents row for invoice');
      }

      const now = new Date();
      const retentionUntil = retentionUntilFrom(now);
      // New writes always start in STANDARD. The S3 Lifecycle rule in
      // infra/modules/archive/main.tf moves them to GLACIER_IR at day 1825.
      const retentionTier: ArchiveRetentionTier = 'STANDARD';
      const retentionUntilAt = retentionUntilAtFrom(now);

      const content = Buffer.from(signed.signedXml, 'utf8');
      const sha256 = sha256Hex(content);

      const putResult = await this.storage.put({
        tenantId,
        invoiceId,
        documentUuid: signed.documentUuid,
        content,
        contentType: 'application/xml',
        retentionUntil,
      });

      // Previous row for this tenant to extend the chain. RLS already
      // restricts to this tenant, but we filter explicitly for clarity.
      const [prev] = await tx
        .select({ sha256: archiveRecords.sha256 })
        .from(archiveRecords)
        .where(eq(archiveRecords.tenantId, tenantId))
        .orderBy(desc(archiveRecords.archivedAt), desc(archiveRecords.id))
        .limit(1);
      const prevSha256 = prev?.sha256 ?? null;

      const chainHash = computeChainHash(prevSha256, sha256);

      const [row] = await tx
        .insert(archiveRecords)
        .values({
          tenantId,
          invoiceId,
          signedDocumentId: signed.id,
          documentUuid: signed.documentUuid,
          storageBackend: putResult.storageBackend,
          storageKey: putResult.storageKey,
          storageBucket: putResult.storageBucket ?? null,
          storageRegion: putResult.storageRegion ?? null,
          sha256,
          prevSha256,
          chainHash,
          contentType: 'application/xml',
          byteSize: content.byteLength,
          retentionUntil: toDateOnly(retentionUntil),
          retentionTier,
          retentionUntilAt,
        })
        .returning();

      await tx
        .update(invoices)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId));

      return row as ArchiveRecordRow;
    });
  }

  async getRecord(tenantId: string, invoiceId: string): Promise<ArchiveRecordRow | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(archiveRecords)
        .where(and(eq(archiveRecords.tenantId, tenantId), eq(archiveRecords.invoiceId, invoiceId)))
        .limit(1);
      return (row as ArchiveRecordRow | undefined) ?? null;
    });
  }

  /**
   * Fetch the archived payload. The storage adapter is called directly;
   * `withTenant` is used to resolve the record under RLS so a caller can
   * only read keys that belong to their tenant.
   *
   * Retention handling (10-year rule):
   *   - If `retention_until_at` is in the past, the S3 Lifecycle rule has
   *     already expired the object: refuse the read with a NotFound rather
   *     than let the adapter 404 with a confusing S3 error message.
   *   - If `retention_tier = 'GLACIER_IR'`, we call the ArchiveReader
   *     helper which does a normal GetObject (no restore needed for
   *     Glacier Instant Retrieval — see ./glacier-reader.ts). The caller
   *     pays the ~2x-STANDARD per-GET cost; the caller's retrieval metric
   *     tracks that separately.
   */
  async getContent(tenantId: string, invoiceId: string): Promise<Buffer | null> {
    const row = await this.getRecord(tenantId, invoiceId);
    if (!row) return null;
    if (row.retentionUntilAt.getTime() <= Date.now()) {
      // Past retention expiration: the object is gone and no amount of
      // retrying will bring it back. Treat as if the row did not exist.
      return null;
    }
    return this.storage.get(row.storageKey, row.storageBucket ?? undefined);
  }

  /**
   * Walk the tenant's archive_records in archived_at order and recompute
   * each row's chain_hash from prev_sha256 and sha256. Any divergence
   * (someone altered a payload hash directly) surfaces at the first row
   * whose stored chain_hash disagrees with the recomputed one.
   */
  async verifyChain(tenantId: string): Promise<ChainVerification> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(archiveRecords)
        .where(eq(archiveRecords.tenantId, tenantId))
        .orderBy(asc(archiveRecords.archivedAt), asc(archiveRecords.id));

      let expectedPrev: string | null = null;
      for (const r of rows as ArchiveRecordRow[]) {
        if ((r.prevSha256 ?? null) !== expectedPrev) {
          return {
            ok: false,
            checked: rows.length,
            breakAt: r.id,
            breakReason: 'prev_sha256 does not match previous row sha256',
          };
        }
        const recomputed = computeChainHash(r.prevSha256, r.sha256);
        if (recomputed !== r.chainHash) {
          return {
            ok: false,
            checked: rows.length,
            breakAt: r.id,
            breakReason: 'chain_hash does not match sha256(prev|sha256)',
          };
        }
        expectedPrev = r.sha256;
      }
      return { ok: true, checked: rows.length };
    });
  }

  /**
   * Return a list of archive records in [from, to] (archived_at inclusive)
   * for auditor export. The auditor fetches each payload separately via
   * `GET /archive/invoices/:id/content`.
   */
  async exportForAuditor(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      id: string;
      invoiceId: string;
      documentUuid: string;
      sha256: string;
      chainHash: string;
      storageKey: string;
      storageBackend: 'filesystem' | 's3';
      archivedAt: Date;
      byteSize: number;
      retentionUntil: string;
      retentionTier: ArchiveRetentionTier;
      retentionUntilAt: Date;
    }>
  > {
    if (!(from instanceof Date) || isNaN(from.getTime())) {
      throw new BadRequestException('`from` is required and must be a valid date');
    }
    if (!(to instanceof Date) || isNaN(to.getTime())) {
      throw new BadRequestException('`to` is required and must be a valid date');
    }
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: archiveRecords.id,
          invoiceId: archiveRecords.invoiceId,
          documentUuid: archiveRecords.documentUuid,
          sha256: archiveRecords.sha256,
          chainHash: archiveRecords.chainHash,
          storageKey: archiveRecords.storageKey,
          storageBackend: archiveRecords.storageBackend,
          archivedAt: archiveRecords.archivedAt,
          byteSize: archiveRecords.byteSize,
          retentionUntil: archiveRecords.retentionUntil,
          retentionTier: archiveRecords.retentionTier,
          retentionUntilAt: archiveRecords.retentionUntilAt,
        })
        .from(archiveRecords)
        .where(
          and(eq(archiveRecords.tenantId, tenantId), between(archiveRecords.archivedAt, from, to)),
        )
        .orderBy(asc(archiveRecords.archivedAt), asc(archiveRecords.id));
      return rows.map((r) => ({
        ...r,
        storageBackend: r.storageBackend as 'filesystem' | 's3',
        byteSize: Number(r.byteSize),
        retentionUntil: String(r.retentionUntil),
        retentionTier: r.retentionTier as ArchiveRetentionTier,
      }));
    });
  }

  /**
   * Reconcile `retention_tier` for the tenant's archive rows that have
   * aged past the GLACIER_IR cutoff in the bucket. Idempotent: rows
   * already in GLACIER_IR are left alone. Intended to be called from a
   * periodic job (daily, via `@nestjs/schedule`).
   *
   * Returns the number of rows that were transitioned to GLACIER_IR on
   * this pass. The S3 Lifecycle rule in infra/modules/archive/main.tf is
   * the source of truth; this method only catches the database up with
   * the bucket so reader cost projections in archive_records can be
   * read without a HeadObject.
   */
  async reconcileTiers(tenantId: string, now: Date = new Date()): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: archiveRecords.id, archivedAt: archiveRecords.archivedAt })
        .from(archiveRecords)
        .where(
          and(eq(archiveRecords.tenantId, tenantId), eq(archiveRecords.retentionTier, 'STANDARD')),
        );
      let flipped = 0;
      for (const r of rows) {
        if (expectedTierFor(r.archivedAt, now) === 'GLACIER_IR') {
          await tx
            .update(archiveRecords)
            .set({ retentionTier: 'GLACIER_IR' })
            .where(eq(archiveRecords.id, r.id));
          flipped += 1;
        }
      }
      return flipped;
    });
  }
}
