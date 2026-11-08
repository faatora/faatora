/**
 * Port for the long-term archive storage backend.
 *
 * The archive service writes the signed XML (and ACK, when the clearance
 * module hands us one) to a backend chosen per environment:
 *   - dev / CI: filesystem (immutable mode 0o400, no overwrite),
 *   - prod:     S3 with Object Lock in COMPLIANCE mode + per-tenant data keys.
 */

export const ARCHIVE_STORAGE = 'ARCHIVE_STORAGE';

export interface ArchiveStoragePutInput {
  tenantId: string;
  invoiceId: string;
  documentUuid: string;
  content: Buffer;
  contentType: string;
  retentionUntil: Date;
}

export interface ArchiveStoragePutResult {
  storageBackend: 'filesystem' | 's3';
  storageKey: string;
  storageBucket?: string;
  storageRegion?: string;
}

export interface ArchiveStorage {
  put(input: ArchiveStoragePutInput): Promise<ArchiveStoragePutResult>;
  get(key: string, bucket?: string): Promise<Buffer>;
}
