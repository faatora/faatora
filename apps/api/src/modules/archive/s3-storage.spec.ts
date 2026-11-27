/**
 * Unit tests for the production S3 archive backend.
 *
 * Uses `aws-sdk-client-mock` to intercept `S3Client.send` so no AWS
 * credentials or network are touched. Every assertion verifies something
 * our OTA Fawtara §5.7 compliance posture depends on:
 *
 *   - PutObject carries Object Lock in COMPLIANCE mode with the exact
 *     retain-until date the service computed (10 years out).
 *   - SSE-KMS is requested on every put — with the configured CMK when
 *     present, and with bucket default encryption otherwise.
 *   - The returned descriptor records the backend, key, bucket and region
 *     so the DB row the archive service writes is self-describing for
 *     disaster recovery.
 *   - GetObject streams back the exact bytes we stored, and honors a
 *     bucket override (used by tieredRead / Glacier reader paths).
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Storage } from './s3-storage';
import type { ArchiveStoragePutInput } from './storage.port';

/**
 * Minimal stand-in for the SDK's stream Body — we only exercise the one
 * helper the adapter uses (`transformToByteArray`), which returns a
 * Uint8Array of the full payload. Avoids pulling in `@smithy/util-stream`
 * just for a test fixture.
 */
function bodyOf(payload: Buffer): { transformToByteArray: () => Promise<Uint8Array> } {
  return {
    transformToByteArray: () =>
      Promise.resolve(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)),
  };
}

const s3Mock = mockClient(S3Client);

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DOCUMENT_UUID = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
// Pick a fixed date that forces YYYY=2026, MM=11 so the key assertion is
// deterministic regardless of when the test runs.
const RETENTION_UNTIL = new Date('2036-11-27T10:00:00.000Z');

function buildInput(overrides: Partial<ArchiveStoragePutInput> = {}): ArchiveStoragePutInput {
  return {
    tenantId: TENANT_ID,
    invoiceId: INVOICE_ID,
    documentUuid: DOCUMENT_UUID,
    content: Buffer.from('<Invoice>signed xml</Invoice>', 'utf8'),
    contentType: 'application/xml',
    retentionUntil: RETENTION_UNTIL,
    ...overrides,
  };
}

describe('S3Storage', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    s3Mock.reset();
    // Baseline env for the happy-path tests; individual tests override.
    process.env.ARCHIVE_BUCKET = 'faatora-archive-prod';
    process.env.AWS_REGION = 'me-south-1';
    delete process.env.ARCHIVE_KMS_KEY_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('put', () => {
    it('throws if ARCHIVE_BUCKET is unset', async () => {
      delete process.env.ARCHIVE_BUCKET;
      const storage = new S3Storage();
      await expect(storage.put(buildInput())).rejects.toThrow(/ARCHIVE_BUCKET and AWS_REGION/);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('throws if AWS_REGION is unset', async () => {
      delete process.env.AWS_REGION;
      const storage = new S3Storage();
      await expect(storage.put(buildInput())).rejects.toThrow(/ARCHIVE_BUCKET and AWS_REGION/);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    it('sends a PutObjectCommand with Object Lock COMPLIANCE and the right retain-until', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const storage = new S3Storage();
      const input = buildInput();

      await storage.put(input);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      const cmd = calls[0]!.args[0].input;
      expect(cmd.Bucket).toBe('faatora-archive-prod');
      expect(cmd.ContentType).toBe('application/xml');
      expect(cmd.Body).toBe(input.content);
      expect(cmd.ObjectLockMode).toBe('COMPLIANCE');
      expect(cmd.ObjectLockRetainUntilDate).toBe(RETENTION_UNTIL);
      // Even without an explicit CMK we request SSE-KMS so the bucket
      // default encryption (set by Terraform) is the only path that can
      // satisfy the request.
      expect(cmd.ServerSideEncryption).toBe('aws:kms');
      expect(cmd.SSEKMSKeyId).toBeUndefined();
    });

    it('sets SSE-KMS with the configured key id when ARCHIVE_KMS_KEY_ID is set', async () => {
      process.env.ARCHIVE_KMS_KEY_ID = 'arn:aws:kms:me-south-1:123456789012:key/abc-def';
      s3Mock.on(PutObjectCommand).resolves({});
      const storage = new S3Storage();

      await storage.put(buildInput());

      const cmd = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(cmd.ServerSideEncryption).toBe('aws:kms');
      expect(cmd.SSEKMSKeyId).toBe('arn:aws:kms:me-south-1:123456789012:key/abc-def');
    });

    it('returns a descriptor with backend, key (<tenantId>/YYYY/MM/<uuid>.xml), bucket and region', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const storage = new S3Storage();
      const now = new Date('2026-03-04T08:00:00.000Z');
      // Pin "now" by calling buildKey; the production put() uses its own
      // `new Date()` so we assert the pattern rather than exact month.
      const expectedKey = storage.buildKey(TENANT_ID, DOCUMENT_UUID, now);
      expect(expectedKey).toBe(`${TENANT_ID}/2026/03/${DOCUMENT_UUID}.xml`);

      const result = await storage.put(buildInput());

      expect(result.storageBackend).toBe('s3');
      expect(result.storageBucket).toBe('faatora-archive-prod');
      expect(result.storageRegion).toBe('me-south-1');
      // Key pattern: <tenantId>/YYYY/MM/<uuid>.xml, where YYYY/MM are the
      // current UTC year/month.
      expect(result.storageKey).toMatch(
        new RegExp(`^${TENANT_ID}/\\d{4}/\\d{2}/${DOCUMENT_UUID}\\.xml$`),
      );
      // The command the mock recorded uses the same key the descriptor
      // reports.
      const cmd = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
      expect(cmd.Key).toBe(result.storageKey);
    });
  });

  describe('get', () => {
    it('returns a Buffer with the object body', async () => {
      const payload = Buffer.from('<Invoice>stored</Invoice>', 'utf8');
      s3Mock
        .on(GetObjectCommand, {
          Bucket: 'faatora-archive-prod',
          Key: 'some/key.xml',
        })
        .resolves({ Body: bodyOf(payload) as never });

      const storage = new S3Storage();
      const out = await storage.get('some/key.xml');

      expect(Buffer.isBuffer(out)).toBe(true);
      expect(out.equals(payload)).toBe(true);
    });

    it('uses the bucket override when passed', async () => {
      const payload = Buffer.from('<Invoice>cold</Invoice>', 'utf8');
      s3Mock.on(GetObjectCommand).callsFake((input) => {
        if (input.Bucket === 'faatora-archive-prod-dr') {
          return Promise.resolve({ Body: bodyOf(payload) });
        }
        return Promise.reject(new Error(`unexpected bucket: ${input.Bucket}`));
      });

      const storage = new S3Storage();
      const out = await storage.get('cold/key.xml', 'faatora-archive-prod-dr');

      expect(out.equals(payload)).toBe(true);
      const calls = s3Mock.commandCalls(GetObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.Bucket).toBe('faatora-archive-prod-dr');
      expect(calls[0]!.args[0].input.Key).toBe('cold/key.xml');
    });
  });
});
