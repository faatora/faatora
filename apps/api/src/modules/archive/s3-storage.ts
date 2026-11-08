import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as path from 'node:path';
import type {
  ArchiveStorage,
  ArchiveStoragePutInput,
  ArchiveStoragePutResult,
} from './storage.port';

/**
 * S3 archive backend — SCAFFOLDING / production hook.
 *
 * Production flips the `ARCHIVE_STORAGE` provider in `archive.module.ts`
 * from `FilesystemStorage` to this class. It is intentionally thin here —
 * only the shape of the production hook is wired up. The actual
 * `@aws-sdk/client-s3` calls are commented out so CI does not need to pull
 * the SDK; add the dependency when wiring S3 for real.
 *
 * The infra counterpart (`infra/modules/archive`) provisions the bucket
 * with Object Lock in COMPLIANCE mode, KMS SSE and lifecycle transition
 * to Deep Archive. This adapter's `put` must therefore pass
 * `ObjectLockMode='COMPLIANCE'` and the matching retain-until date so
 * the per-object retention is at least as strong as the bucket default.
 *
 * Environment:
 *   - ARCHIVE_BUCKET     — bucket name (required)
 *   - AWS_REGION         — bucket region (required)
 *   - ARCHIVE_KMS_KEY_ID — KMS CMK ARN or alias (optional; when present,
 *                         PutObject sets SSE-KMS with this key)
 */
@Injectable()
export class S3Storage implements ArchiveStorage {
  private readonly bucket: string;
  private readonly region: string;
  private readonly kmsKeyId: string | undefined;

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

  async put(input: ArchiveStoragePutInput): Promise<ArchiveStoragePutResult> {
    if (!this.bucket || !this.region) {
      throw new InternalServerErrorException(
        'S3Storage: ARCHIVE_BUCKET and AWS_REGION env vars are required',
      );
    }
    // Production hook — uncomment after adding @aws-sdk/client-s3:
    //
    // const key = this.buildKey(input.tenantId, input.documentUuid);
    // const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    // const client = new S3Client({ region: this.region });
    // await client.send(
    //   new PutObjectCommand({
    //     Bucket: this.bucket,
    //     Key: key,
    //     Body: input.content,
    //     ContentType: input.contentType,
    //     ObjectLockMode: 'COMPLIANCE',
    //     ObjectLockRetainUntilDate: input.retentionUntil,
    //     ...(this.kmsKeyId
    //       ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }
    //       : {}),
    //   }),
    // );
    // return { storageBackend: 's3', storageKey: key, storageBucket: this.bucket, storageRegion: this.region };
    void input;
    void this.kmsKeyId;

    throw new InternalServerErrorException(
      'S3Storage is scaffolding only — install @aws-sdk/client-s3 and enable the PutObject block to use it in production.',
    );
  }

  async get(key: string, bucket?: string): Promise<Buffer> {
    // Production hook — uncomment after adding @aws-sdk/client-s3:
    //
    // const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    // const client = new S3Client({ region: this.region });
    // const resp = await client.send(
    //   new GetObjectCommand({ Bucket: bucket ?? this.bucket, Key: key }),
    // );
    // const chunks: Buffer[] = [];
    // for await (const chunk of resp.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    // return Buffer.concat(chunks);

    throw new InternalServerErrorException(
      `S3Storage.get is scaffolding only (key=${key} bucket=${bucket ?? this.bucket}).`,
    );
  }
}
