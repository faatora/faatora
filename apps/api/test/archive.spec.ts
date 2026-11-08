import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withTenant } from '../src/db/with-tenant';
import * as schema from '../src/db/schema';
import { archiveRecords } from '../src/db/schema/archive';
import { ArchiveService } from '../src/modules/archive/archive.service';
import { FilesystemStorage } from '../src/modules/archive/filesystem-storage';
import { computeChainHash, sha256Hex } from '../src/modules/archive/hash-chain';
import type { Database } from '../src/db/db.module';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

interface SeedResult {
  invoiceId: string;
  signedDocumentId: string;
  documentUuid: string;
  signedXml: string;
  issueDate: string;
}

describe('Archive', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let db: Database;
  let supplierT1: string;
  let supplierT2: string;
  let buyerT1: string;
  let buyerT2: string;
  let archiveDir: string;
  let storage: FilesystemStorage;
  let svc: ArchiveService;

  async function seedClearedInvoice(
    tenantId: string,
    supplierId: string,
    buyerId: string,
    opts: { number: string; xmlPayload: string; issueDate?: string },
  ): Promise<SeedResult> {
    const documentUuid = randomUUID();
    const issueDate = opts.issueDate ?? '2026-05-01';
    const inv = await admin.query(
      `INSERT INTO invoices (tenant_id, type, number, document_uuid, status, currency, issue_date,
         supplier_party_id, buyer_party_id, subtotal, vat_total, grand_total, vat_breakdown)
       VALUES ($1,'invoice',$2,$3,'CLEARED','OMR',$4,$5,$6,'100.000','5.000','105.000','[]'::jsonb)
       RETURNING id`,
      [tenantId, opts.number, documentUuid, issueDate, supplierId, buyerId],
    );
    const invoiceId = inv.rows[0].id as string;
    const sha = createHash('sha256').update(opts.xmlPayload, 'utf8').digest('hex');
    const signed = await admin.query(
      `INSERT INTO signed_documents (tenant_id, invoice_id, document_uuid, signed_xml,
         signature_value, signature_algorithm, key_id, qr_png_base64, pdf_base64, sha256)
       VALUES ($1,$2,$3,$4,'ZmFrZS1zaWc=','RSA-SHA256','local-dev-key','UFJO','UERG',$5)
       RETURNING id`,
      [tenantId, invoiceId, documentUuid, opts.xmlPayload, sha],
    );
    return {
      invoiceId,
      signedDocumentId: signed.rows[0].id as string,
      documentUuid,
      signedXml: opts.xmlPayload,
      issueDate,
    };
  }

  beforeAll(async () => {
    archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faatora-archive-test-'));
    process.env.FAATORA_ARCHIVE_DIR = archiveDir;
    storage = new FilesystemStorage();

    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'ARC-T1'),($2,'ARC-T2')`, [
      t1,
      t2,
    ]);
    supplierT1 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S1') RETURNING id`,
        [t1],
      )
    ).rows[0].id as string;
    buyerT1 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B1') RETURNING id`,
        [t1],
      )
    ).rows[0].id as string;
    supplierT2 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S2') RETURNING id`,
        [t2],
      )
    ).rows[0].id as string;
    buyerT2 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B2') RETURNING id`,
        [t2],
      )
    ).rows[0].id as string;

    appPool = new Pool({ connectionString: APP_URL });
    db = drizzle(appPool, { schema }) as Database;
    svc = new ArchiveService(db, storage);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [t1, t2]);
    await appPool.end();
    await admin.end();
    await fs.rm(archiveDir, { recursive: true, force: true });
  });

  it('archive happy path: writes file, inserts row, flips invoice to ARCHIVED', async () => {
    const xml = '<Invoice><ID>ARC-HAPPY-1</ID></Invoice>';
    const seed = await seedClearedInvoice(t1, supplierT1, buyerT1, {
      number: 'ARC-HAPPY-1',
      xmlPayload: xml,
    });
    const result = await svc.archiveInvoice(t1, seed.invoiceId);
    if ('skipped' in result) throw new Error('expected archive success');

    // Row shape
    expect(result.invoiceId).toBe(seed.invoiceId);
    expect(result.documentUuid).toBe(seed.documentUuid);
    expect(result.storageBackend).toBe('filesystem');
    expect(result.sha256).toBe(createHash('sha256').update(xml, 'utf8').digest('hex'));
    expect(result.prevSha256).toBeNull();
    expect(result.chainHash).toBe(computeChainHash(null, result.sha256));
    expect(Number(result.byteSize)).toBe(Buffer.byteLength(xml, 'utf8'));

    // File on disk
    const abs = path.join(archiveDir, result.storageKey);
    const onDisk = await fs.readFile(abs, 'utf8');
    expect(onDisk).toBe(xml);
    const stat = await fs.stat(abs);
    // Mode 0o400 — read-only for the owner, no group/other access.
    expect(stat.mode & 0o777).toBe(0o400);

    // Invoice flipped to ARCHIVED
    const [inv] = await withTenant(db, t1, (tx) =>
      tx.select().from(schema.invoices).where(eq(schema.invoices.id, seed.invoiceId)).limit(1),
    );
    expect(inv.status).toBe('ARCHIVED');
  });

  it('immutability: a second archive call is a safe no-op (invoice already ARCHIVED)', async () => {
    const xml = '<Invoice><ID>ARC-IMM-1</ID></Invoice>';
    const seed = await seedClearedInvoice(t1, supplierT1, buyerT1, {
      number: 'ARC-IMM-1',
      xmlPayload: xml,
    });
    const first = await svc.archiveInvoice(t1, seed.invoiceId);
    expect('skipped' in first).toBe(false);

    const second = await svc.archiveInvoice(t1, seed.invoiceId);
    expect('skipped' in second).toBe(true);
    if ('skipped' in second) {
      expect(second.reason).toMatch(/ARCHIVED/);
    }

    // Belt-and-braces: UNIQUE(tenant_id, invoice_id) also blocks a direct
    // second insert even if someone bypassed the status check.
    const [existing] = await withTenant(db, t1, (tx) =>
      tx.select().from(archiveRecords).where(eq(archiveRecords.invoiceId, seed.invoiceId)).limit(1),
    );
    await expect(
      withTenant(db, t1, (tx) =>
        tx.insert(archiveRecords).values({
          tenantId: t1,
          invoiceId: seed.invoiceId,
          signedDocumentId: existing.signedDocumentId,
          documentUuid: existing.documentUuid,
          storageBackend: 'filesystem',
          storageKey: existing.storageKey,
          sha256: existing.sha256,
          prevSha256: existing.sha256,
          chainHash: computeChainHash(existing.sha256, existing.sha256),
          contentType: 'application/xml',
          byteSize: existing.byteSize,
          retentionUntil: existing.retentionUntil,
        }),
      ),
    ).rejects.toThrow();
  });

  it('hash chain: three invoices under one tenant produce a verifiable chain', async () => {
    const tenantId = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'ARC-CHAIN')`, [tenantId]);
    try {
      const supplier = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const buyer = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;

      const payloads = ['<a/>', '<b/>', '<c/>'];
      const results: Array<{ sha256: string; chainHash: string; prevSha256: string | null }> = [];
      for (let i = 0; i < payloads.length; i++) {
        const seed = await seedClearedInvoice(tenantId, supplier, buyer, {
          number: `ARC-CHAIN-${i + 1}`,
          xmlPayload: payloads[i],
        });
        const r = await svc.archiveInvoice(tenantId, seed.invoiceId);
        if ('skipped' in r) throw new Error('expected archive success');
        results.push({ sha256: r.sha256, chainHash: r.chainHash, prevSha256: r.prevSha256 });
      }

      // Each chain_hash is sha256(prev + "|" + sha256), and each prev is the
      // previous sha256 (null for the first).
      expect(results[0].prevSha256).toBeNull();
      expect(results[0].chainHash).toBe(computeChainHash(null, results[0].sha256));
      expect(results[1].prevSha256).toBe(results[0].sha256);
      expect(results[1].chainHash).toBe(computeChainHash(results[0].sha256, results[1].sha256));
      expect(results[2].prevSha256).toBe(results[1].sha256);
      expect(results[2].chainHash).toBe(computeChainHash(results[1].sha256, results[2].sha256));

      const v = await svc.verifyChain(tenantId);
      expect(v.ok).toBe(true);
      expect(v.checked).toBe(3);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('chain tamper detection: altering a middle row sha256 surfaces in verifyChain', async () => {
    const tenantId = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'ARC-TAMPER')`, [tenantId]);
    try {
      const supplier = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const buyer = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;

      const seeded: string[] = [];
      for (let i = 0; i < 3; i++) {
        const seed = await seedClearedInvoice(tenantId, supplier, buyer, {
          number: `ARC-TMP-${i + 1}`,
          xmlPayload: `<p>${i}</p>`,
        });
        const r = await svc.archiveInvoice(tenantId, seed.invoiceId);
        if ('skipped' in r) throw new Error('expected archive success');
        seeded.push(seed.invoiceId);
      }

      const rows = (
        await admin.query(
          `SELECT id, sha256, archived_at FROM archive_records WHERE tenant_id=$1
           ORDER BY archived_at ASC, id ASC`,
          [tenantId],
        )
      ).rows as Array<{ id: string; sha256: string }>;
      const middle = rows[1];

      // Tamper with the middle row's sha256 directly.
      await admin.query(`UPDATE archive_records SET sha256 = $1 WHERE id = $2`, [
        'deadbeef'.repeat(8),
        middle.id,
      ]);

      const v = await svc.verifyChain(tenantId);
      expect(v.ok).toBe(false);
      expect(v.breakAt).toBe(middle.id);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('exportForAuditor filters by archived_at range', async () => {
    const tenantId = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'ARC-EXPORT')`, [tenantId]);
    try {
      const supplier = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const buyer = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;

      const invoiceIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const seed = await seedClearedInvoice(tenantId, supplier, buyer, {
          number: `ARC-EXP-${i + 1}`,
          xmlPayload: `<x>${i}</x>`,
        });
        const r = await svc.archiveInvoice(tenantId, seed.invoiceId);
        if ('skipped' in r) throw new Error('expected archive success');
        invoiceIds.push(seed.invoiceId);
      }

      // Rewrite archived_at to span three distinct days.
      const days = ['2026-07-01', '2026-07-02', '2026-07-03'];
      for (let i = 0; i < invoiceIds.length; i++) {
        await admin.query(
          `UPDATE archive_records SET archived_at = $1::timestamptz WHERE invoice_id = $2`,
          [`${days[i]}T12:00:00Z`, invoiceIds[i]],
        );
      }

      const all = await svc.exportForAuditor(
        tenantId,
        new Date('2026-07-01T00:00:00Z'),
        new Date('2026-07-03T23:59:59Z'),
      );
      expect(all).toHaveLength(3);

      const narrow = await svc.exportForAuditor(
        tenantId,
        new Date('2026-07-02T00:00:00Z'),
        new Date('2026-07-02T23:59:59Z'),
      );
      expect(narrow).toHaveLength(1);
      expect(narrow[0].invoiceId).toBe(invoiceIds[1]);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('cross-tenant isolation: tenant B cannot read tenant A archive_records', async () => {
    const xmlA = '<Invoice><ID>ARC-ISO-A</ID></Invoice>';
    const seedA = await seedClearedInvoice(t1, supplierT1, buyerT1, {
      number: 'ARC-ISO-A',
      xmlPayload: xmlA,
    });
    const rA = await svc.archiveInvoice(t1, seedA.invoiceId);
    if ('skipped' in rA) throw new Error('expected archive success');

    // Also archive one for tenant B so verifyChain for B has something to check.
    const seedB = await seedClearedInvoice(t2, supplierT2, buyerT2, {
      number: 'ARC-ISO-B',
      xmlPayload: '<Invoice><ID>ARC-ISO-B</ID></Invoice>',
    });
    const rB = await svc.archiveInvoice(t2, seedB.invoiceId);
    if ('skipped' in rB) throw new Error('expected archive success');

    // From B's RLS context, A's archive row is invisible.
    const seenFromT2 = await withTenant(db, t2, (tx) =>
      tx
        .select()
        .from(archiveRecords)
        .where(inArray(archiveRecords.id, [rA.id])),
    );
    expect(seenFromT2).toHaveLength(0);

    // B's chain contains only B's row.
    const vT2 = await svc.verifyChain(t2);
    expect(vT2.ok).toBe(true);
    expect(vT2.checked).toBeGreaterThanOrEqual(1);
  });

  it('filesystem immutability: a second put to the same path fails (EEXIST + mode 0o400)', async () => {
    const tenantId = randomUUID();
    const documentUuid = randomUUID();
    const content = Buffer.from('<immutable/>', 'utf8');
    const put1 = await storage.put({
      tenantId,
      invoiceId: randomUUID(),
      documentUuid,
      content,
      contentType: 'application/xml',
      retentionUntil: new Date(),
    });

    // Mode is 0o400 on disk.
    const abs = path.join(archiveDir, put1.storageKey);
    const stat = await fs.stat(abs);
    expect(stat.mode & 0o777).toBe(0o400);

    // A second put to the same (tenant, document_uuid) resolves to the same
    // storage key and fails with EEXIST because of the `wx` create flag.
    await expect(
      storage.put({
        tenantId,
        invoiceId: randomUUID(),
        documentUuid,
        content: Buffer.from('<tampered/>', 'utf8'),
        contentType: 'application/xml',
        retentionUntil: new Date(),
      }),
    ).rejects.toThrow(/EEXIST/);

    // And the file contents are unchanged.
    const after = await fs.readFile(abs, 'utf8');
    expect(after).toBe('<immutable/>');
  });

  it('retention_until = archived_at + 10 years (to the day)', async () => {
    const xml = '<Invoice><ID>ARC-RET-1</ID></Invoice>';
    const seed = await seedClearedInvoice(t1, supplierT1, buyerT1, {
      number: 'ARC-RET-1',
      xmlPayload: xml,
    });
    const r = await svc.archiveInvoice(t1, seed.invoiceId);
    if ('skipped' in r) throw new Error('expected archive success');

    const archivedAt = new Date(r.archivedAt);
    // retentionUntil is stored as a date (YYYY-MM-DD) — compare year/month/day
    // against archivedAt + 10 years in UTC.
    const retention = new Date(`${String(r.retentionUntil)}T00:00:00Z`);
    expect(retention.getUTCFullYear()).toBe(archivedAt.getUTCFullYear() + 10);
    expect(retention.getUTCMonth()).toBe(archivedAt.getUTCMonth());
    expect(retention.getUTCDate()).toBe(archivedAt.getUTCDate());
  });

  it('getRecord + getContent round-trips the archived XML', async () => {
    const xml = '<Invoice><ID>ARC-RT-1</ID></Invoice>';
    const seed = await seedClearedInvoice(t1, supplierT1, buyerT1, {
      number: 'ARC-RT-1',
      xmlPayload: xml,
    });
    const r = await svc.archiveInvoice(t1, seed.invoiceId);
    if ('skipped' in r) throw new Error('expected archive success');

    const record = await svc.getRecord(t1, seed.invoiceId);
    expect(record?.id).toBe(r.id);
    const content = await svc.getContent(t1, seed.invoiceId);
    expect(content?.toString('utf8')).toBe(xml);
  });

  it('sha256Hex matches the SHA-256 of the UTF-8 bytes', () => {
    const buf = Buffer.from('hello', 'utf8');
    expect(sha256Hex(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
    // Pin an explicit value so this is not just a tautology.
    expect(sha256Hex(buf)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
