/**
 * ClearTax §5.7 declared-subcontractor commitment — reading objects in the
 * cold (year 5-10) tier.
 *
 * Glacier Instant Retrieval (GLACIER_IR) is the archival storage class the
 * S3 Lifecycle rule in infra/modules/archive/main.tf moves an object to at
 * day 1825 (5 years from archived_at). Unlike Glacier Flexible Retrieval
 * or Deep Archive, GLACIER_IR serves reads SYNCHRONOUSLY: a normal
 * GetObject call returns the bytes with no RestoreObject step and no
 * 3-5 hour wait. That is the whole reason we picked GLACIER_IR for the
 * second 5-year slice of the OTA 10-year retention: inspectors expect the
 * same auditor-export endpoint to work whether the object is in year 2 or
 * year 8, and GLACIER_IR delivers that.
 *
 * Cost note (frozen here so it does not get lost):
 *   - STANDARD    ~ $0.023 / GB / month storage, ~ $0.0004 / 1000 GETs.
 *   - GLACIER_IR  ~ $0.004 / GB / month storage, ~ $0.01   / 1000 GETs
 *                 + $0.03 / GB minimum-90-day retrieval fee for data
 *                   retrieved earlier than 90 days after transition.
 *   So reads in year 5-10 are ~25x the per-GET cost of year 0-5. For OTA
 *   inspection volumes (bounded by the Tax Authority's own inspector
 *   cadence) that is still comfortably under the storage-saving.
 *
 * API-wise, GLACIER_IR behaves exactly like STANDARD for reads, so
 * ArchiveService.getContent calls the same `storage.get(key, bucket)` on
 * both. This file exists to document the contract AND to give the
 * ArchiveReader a single entry point we can swap for a tier-aware
 * metric-tracking implementation later without changing callers.
 */
import type { ArchiveStorage } from './storage.port';
import type { ArchiveRetentionTier } from '../../db/schema/archive';

export interface TieredReadResult {
  content: Buffer;
  /** The tier the row was recorded in when the read started. */
  readFromTier: ArchiveRetentionTier;
  /** Approximate cost class, used for the retrieval metric. */
  costClass: 'standard-get' | 'glacier-ir-get';
}

/**
 * Read an archived object from either tier.
 *
 * We deliberately do NOT call S3 HeadObject to check the live tier — the
 * database's `retention_tier` is authoritative (kept in sync by the
 * daily `ArchiveService.reconcileTiers` job). A HeadObject before every
 * GetObject would double the per-read cost.
 */
export async function tieredRead(
  storage: ArchiveStorage,
  key: string,
  bucket: string | undefined,
  recordedTier: ArchiveRetentionTier,
): Promise<TieredReadResult> {
  const content = await storage.get(key, bucket);
  return {
    content,
    readFromTier: recordedTier,
    costClass: recordedTier === 'GLACIER_IR' ? 'glacier-ir-get' : 'standard-get',
  };
}
