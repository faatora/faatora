import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type {
  ArchiveStorage,
  ArchiveStoragePutInput,
  ArchiveStoragePutResult,
} from './storage.port';

/**
 * S3 archive backend — production.
 *
 * Production flips the `ARCHIVE_STORAGE` provider in `archive.module.ts`
 * from `FilesystemStorage` to this class (env-driven: `ARCHIVE_STORAGE_BACKEND`
 * or `NODE_ENV=production`).
 *
 * The infra counterpart (`infra/modules/archive`) provisions the bucket
 * with Object Lock in COMPLIANCE mode, KMS SSE and lifecycle transition
 * STANDARD -> GLACIER_IR at 5y. This adapter's `put` therefore passes
 * `ObjectLockMode='COMPLIANCE'` and the matching retain-until date so
 * the per-object retention is at least as strong as the bucket default,
 * which keeps the OTA Fawtara §5.7 10-year retention enforceable even if
 * bucket defaults are tampered with later.
 *
 * Environment:
 *   - ARCHIVE_BUCKET     — bucket name (required)
 *   - AWS_REGION         — bucket region (required)
 *   - ARCHIVE_KMS_KEY_ID — KMS CMK ARN or alias (optional; when present,
 *                         PutObject sets SSE-KMS with this key. When absent,
 *                         the bucket-level default encryption still applies
 *                         because the Terraform module configures SSE-KMS
 *                         on the bucket, and we still request
 *                         `ServerSideEncryption: 'aws:kms'` so the request
 *                         is rejected if a bucket without default encryption
 *                         is ever substituted).
 */
@Injectable()
export class S3Storage implements ArchiveStorage {
  private readonly bucket: string;
  private readonly region: string;
  private readonly kmsKeyId: string | undefined;
  private client: S3Client | undefined;

  constructor() {
    this.bucket = process.env.ARCHIVE_BUCKET ?? '';
    this.region = process.env.AWS_REGION ?? '';
    this.kmsKeyId = process.env.ARCHIVE_KMS_KEY_ID;
  }

  buildKey(tenantId: string, documentUuid: string, now: Date = new Date()): string {
    const year = now.getUTCFullYear().toString().padStart(4, '0');
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    return path.posix.join(tenantId, year, month, `${documentUuid}.xml`);
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({ region: this.region });
    }
    return this.client;
  }

  async put(input: ArchiveStoragePutInput): Promise<ArchiveStoragePutResult> {
    if (!this.bucket || !this.region) {
      throw new InternalServerErrorException(
        'S3Storage: ARCHIVE_BUCKET and AWS_REGION env vars are required',
      );
    }
    const key = this.buildKey(input.tenantId, input.documentUuid);
    const client = this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.content,
        ContentType: input.contentType,
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: input.retentionUntil,
        ...(this.kmsKeyId
          ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }
          : { ServerSideEncryption: 'aws:kms' }),
      }),
    );
    return {
      storageBackend: 's3',
      storageKey: key,
      storageBucket: this.bucket,
      storageRegion: this.region,
    };
  }

  async get(key: string, bucket?: string): Promise<Buffer> {
    const client = this.getClient();
    const resp = await client.send(
      new GetObjectCommand({ Bucket: bucket ?? this.bucket, Key: key }),
    );
    if (!resp.Body) {
      throw new InternalServerErrorException(
        `S3Storage.get: empty body for key=${key} bucket=${bucket ?? this.bucket}`,
      );
    }
    const bytes = await resp.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}
