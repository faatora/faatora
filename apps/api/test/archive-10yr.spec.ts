/**
 * ClearTax §5.7 declared-subcontractor commitment — 10-year retention tests.
 *
 * Covers:
 *   - expectedTierFor transitions STANDARD -> GLACIER_IR at day 1825 and
 *     stays GLACIER_IR up to and past day 3650.
 *   - retentionUntilAtFrom lands exactly 3650 days after archived_at.
 *   - tieredRead delegates to the ArchiveStorage port on both tiers and
 *     returns the right costClass for the recorded tier (GLACIER_IR
 *     Instant Retrieval is a synchronous GetObject — no RestoreObject).
 *   - A minimal LocalStack-style S3 mock implements ArchiveStorage; a
 *     read through tieredRead returns the exact bytes a put stored, so
 *     the archive reader does NOT need a tier-specific code path for
 *     GLACIER_IR.
 *
 * These are unit tests against pure functions and an in-memory mock; no
 * real AWS, no DATABASE_URL, no LocalStack daemon.
 */
import { expectedTierFor, retentionUntilAtFrom } from '../src/modules/archive/archive.service';
import { tieredRead } from '../src/modules/archive/glacier-reader';
import type {
  ArchiveStorage,
  ArchiveStoragePutInput,
  ArchiveStoragePutResult,
} from '../src/modules/archive/storage.port';

/**
 * In-memory ArchiveStorage. Plays the role LocalStack would in a heavier
 * fixture: accepts PutObject-shaped input, surfaces it by key on get. We
 * deliberately do NOT model the Glacier retrieval delay because
 * GLACIER_IR has none — a GetObject against a GLACIER_IR-tier object
 * returns synchronously, which is what makes it viable for OTA
 * inspection reads in year 5-10.
 */
class InMemoryS3Mock implements ArchiveStorage {
  private readonly store = new Map<string, Buffer>();
  public lastPutInput: ArchiveStoragePutInput | null = null;
  public getCallCount = 0;

  async put(input: ArchiveStoragePutInput): Promise<ArchiveStoragePutResult> {
    this.lastPutInput = input;
    const key = `s3://mock-archive/${input.tenantId}/${input.documentUuid}.xml`;
    if (this.store.has(key)) {
      // Mirror S3 with Object Lock: a PutObject at a locked key either
      // creates a new version (versioned bucket) or 409s. For the chain
      // test it is enough to refuse.
      throw new Error('object already exists (Object Lock COMPLIANCE)');
    }
    this.store.set(key, input.content);
    return {
      storageBackend: 's3',
      storageKey: key,
      storageBucket: 'mock-archive',
      storageRegion: 'eu-central-1',
    };
  }

  async get(key: string): Promise<Buffer> {
    this.getCallCount += 1;
    const v = this.store.get(key);
    if (!v) throw new Error(`NoSuchKey: ${key}`);
    return v;
  }
}

describe('expectedTierFor (OTA §5.7 5+5 split)', () => {
  const archivedAt = new Date('2026-01-01T00:00:00.000Z');

  it('is STANDARD at day 0', () => {
    expect(expectedTierFor(archivedAt, archivedAt)).toBe('STANDARD');
  });

  it('stays STANDARD on day 1824 (last hot day)', () => {
    const day1824 = new Date(archivedAt.getTime() + 1824 * 86400 * 1000);
    expect(expectedTierFor(archivedAt, day1824)).toBe('STANDARD');
  });

  it('flips to GLACIER_IR on day 1825 (5-year cutoff)', () => {
    const day1825 = new Date(archivedAt.getTime() + 1825 * 86400 * 1000);
    expect(expectedTierFor(archivedAt, day1825)).toBe('GLACIER_IR');
  });

  it('stays GLACIER_IR on day 3649 (last cold day)', () => {
    const day3649 = new Date(archivedAt.getTime() + 3649 * 86400 * 1000);
    expect(expectedTierFor(archivedAt, day3649)).toBe('GLACIER_IR');
  });

  it('is still GLACIER_IR past day 3650 (expiration is a bucket-side action, not a tier flip)', () => {
    const day3651 = new Date(archivedAt.getTime() + 3651 * 86400 * 1000);
    expect(expectedTierFor(archivedAt, day3651)).toBe('GLACIER_IR');
  });
});

describe('retentionUntilAtFrom (OTA §5.7 expiration ceiling)', () => {
  it('lands exactly 3650 days (10 years) after archived_at', () => {
    const archivedAt = new Date('2026-03-15T09:00:00.000Z');
    const until = retentionUntilAtFrom(archivedAt);
    const deltaDays = (until.getTime() - archivedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBe(3650);
  });
});

describe('tieredRead (archive reader for STANDARD and GLACIER_IR)', () => {
  const tenantId = '00000000-0000-0000-0000-00000000aaaa';
  const documentUuid = '00000000-0000-0000-0000-000000000001';
  const payload = Buffer.from('<Invoice><ID>GLACIER-IR-OK</ID></Invoice>', 'utf8');

  it('STANDARD: reads with a single GetObject and reports cost class standard-get', async () => {
    const s3 = new InMemoryS3Mock();
    const put = await s3.put({
      tenantId,
      invoiceId: '00000000-0000-0000-0000-000000000011',
      documentUuid,
      content: payload,
      contentType: 'application/xml',
      retentionUntil: new Date(Date.now() + 3650 * 86400 * 1000),
    });
    expect(put.storageBackend).toBe('s3');

    const result = await tieredRead(s3, put.storageKey, put.storageBucket, 'STANDARD');
    expect(result.content.toString('utf8')).toBe(payload.toString('utf8'));
    expect(result.readFromTier).toBe('STANDARD');
    expect(result.costClass).toBe('standard-get');
    expect(s3.getCallCount).toBe(1);
  });

  it('GLACIER_IR: reads with a single GetObject (NO RestoreObject) and reports cost class glacier-ir-get', async () => {
    const s3 = new InMemoryS3Mock();
    const put = await s3.put({
      tenantId,
      invoiceId: '00000000-0000-0000-0000-000000000012',
      documentUuid,
      content: payload,
      contentType: 'application/xml',
      retentionUntil: new Date(Date.now() + 3650 * 86400 * 1000),
    });
    // The bucket lifecycle rule has already moved this object to
    // GLACIER_IR in the "simulated five years later" scenario; from the
    // caller's perspective, a GetObject still returns synchronously.
    const result = await tieredRead(s3, put.storageKey, put.storageBucket, 'GLACIER_IR');
    expect(result.content.toString('utf8')).toBe(payload.toString('utf8'));
    expect(result.readFromTier).toBe('GLACIER_IR');
    expect(result.costClass).toBe('glacier-ir-get');
    // Exactly one GET — if we had accidentally wired a "restore then read"
    // flow (the Flexible / Deep Archive pattern), this would be > 1.
    expect(s3.getCallCount).toBe(1);
  });

  it('A missing key surfaces as an error, not a silent empty buffer', async () => {
    const s3 = new InMemoryS3Mock();
    await expect(
      tieredRead(s3, 's3://mock-archive/does-not-exist.xml', 'mock-archive', 'STANDARD'),
    ).rejects.toThrow(/NoSuchKey/);
  });
});

describe('S3 Object Lock behaviour (mocked)', () => {
  it('a second put to the same documentUuid is refused (COMPLIANCE immutability)', async () => {
    const s3 = new InMemoryS3Mock();
    const common = {
      tenantId: '00000000-0000-0000-0000-00000000aaaa',
      invoiceId: '00000000-0000-0000-0000-000000000099',
      documentUuid: '00000000-0000-0000-0000-000000000100',
      contentType: 'application/xml',
      retentionUntil: new Date(Date.now() + 3650 * 86400 * 1000),
    };
    await s3.put({ ...common, content: Buffer.from('<v1/>') });
    await expect(s3.put({ ...common, content: Buffer.from('<v2/>') })).rejects.toThrow(
      /COMPLIANCE/,
    );
  });
});
