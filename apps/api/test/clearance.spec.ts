import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as schema from '../src/db/schema';
import { withTenant } from '../src/db/with-tenant';
import { invoices } from '../src/db/schema/invoicing';
import { archiveRecords } from '../src/db/schema/archive';
import { clearanceDlq, clearanceEvents, clearanceOutbox } from '../src/db/schema/clearance';
import { ClearanceGatewayService } from '../src/modules/clearance/clearance-gateway.service';
import { TransmissionCircuitBreaker } from '../src/modules/clearance/circuit-breaker';
import { StubAspProvider, resetStubAspState } from '../src/modules/clearance/stub-asp';
import { ArchiveService } from '../src/modules/archive/archive.service';
import { FilesystemStorage } from '../src/modules/archive/filesystem-storage';
import type {
  TransmissionProvider,
  TransmissionResult,
  TransmissionSubmission,
} from '../src/modules/clearance/transmission-provider.port';
import type { Database } from '../src/db/db.module';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

// Keep the scheduler from poking us mid-test.
process.env.DISABLE_CLEARANCE_CRON = '1';

interface SeededInvoice {
  tenantId: string;
  invoiceId: string;
  documentUuid: string;
}

async function seedSignedInvoice(
  admin: Pool,
  tenantId: string,
  numberSuffix: string,
  options: { forceReject?: boolean } = {},
): Promise<SeededInvoice> {
  const partyId = (
    await admin.query(
      `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer',$2) RETURNING id`,
      [tenantId, `P-${numberSuffix}`],
    )
  ).rows[0].id as string;

  const invoiceId = randomUUID();
  const docUuid = randomUUID();

  await admin.query(
    `INSERT INTO invoices
       (id, tenant_id, number, document_uuid, status, currency, issue_date,
        supplier_party_id, buyer_party_id, subtotal, vat_total, grand_total)
     VALUES ($1,$2,$3,$4,'SIGNED','OMR','2026-10-17',$5,$5,100.000,5.000,105.000)`,
    [invoiceId, tenantId, `INV-${numberSuffix}`, docUuid, partyId],
  );

  const body = options.forceReject
    ? `<Invoice><ID>INV-${numberSuffix}</ID><ForceReject>true</ForceReject></Invoice>`
    : `<Invoice><ID>INV-${numberSuffix}</ID></Invoice>`;

  await admin.query(
    `INSERT INTO signed_documents
       (tenant_id, invoice_id, document_uuid, signed_xml, signature_value,
        signature_algorithm, key_id, qr_png_base64, sha256)
     VALUES ($1,$2,$3,$4,$5,'RSA-SHA256','local-dev-key','iVBOR...','deadbeef')`,
    [tenantId, invoiceId, docUuid, body, 'ZmFrZS1zaWc='],
  );

  return { tenantId, invoiceId, documentUuid: docUuid };
}

describe('ClearanceGatewayService', () => {
  let admin: Pool;
  let appPool: Pool;
  let db: Database;
  let archiveDir: string;
  let archiveService: ArchiveService;
  const createdTenants: string[] = [];
  const activeGateways: ClearanceGatewayService[] = [];

  async function makeTenant(label: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [id, label]);
    createdTenants.push(id);
    return id;
  }

  function makeGateway(
    provider?: TransmissionProvider,
    opts: { archive?: ArchiveService | null } = {},
  ): ClearanceGatewayService {
    const stub = new StubAspProvider(null);
    const gw = new ClearanceGatewayService(
      db,
      provider ?? stub,
      new TransmissionCircuitBreaker(),
      opts.archive === undefined ? archiveService : opts.archive,
    );
    activeGateways.push(gw);
    return gw;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    appPool = new Pool({ connectionString: APP_URL });
    db = drizzle(appPool, { schema }) as Database;
    archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faatora-clearance-archive-'));
    process.env.FAATORA_ARCHIVE_DIR = archiveDir;
    archiveService = new ArchiveService(db, new FilesystemStorage());
  });

  afterAll(async () => {
    for (const gw of activeGateways) await gw.closeInternalPool();
    if (createdTenants.length) {
      // Clear outbox, events, dlq, archive_records before dropping tenants
      // (FK CASCADE handles the rest, but we explicitly null the drain
      // backlog so a stale row can't influence another spec that runs
      // after this file).
      await admin.query(`DELETE FROM clearance_outbox WHERE tenant_id = ANY($1::uuid[])`, [
        createdTenants,
      ]);
      await admin.query(`DELETE FROM clearance_events WHERE tenant_id = ANY($1::uuid[])`, [
        createdTenants,
      ]);
      await admin.query(`DELETE FROM clearance_dlq WHERE tenant_id = ANY($1::uuid[])`, [
        createdTenants,
      ]);
      await admin.query(`DELETE FROM archive_records WHERE tenant_id = ANY($1::uuid[])`, [
        createdTenants,
      ]);
      await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [createdTenants]);
    }
    await appPool.end();
    await admin.end();
    await fs.rm(archiveDir, { recursive: true, force: true });
  });

  // The drain sweeps queued rows across all tenants in this file. Between
  // tests we clean out any leftover queued rows from earlier tests so each
  // test only sees its own work.
  beforeEach(async () => {
    resetStubAspState();
    delete process.env.STUB_ASP_MODE;
    if (createdTenants.length) {
      await admin.query(
        `DELETE FROM clearance_outbox WHERE tenant_id = ANY($1::uuid[]) AND status = 'queued'`,
        [createdTenants],
      );
    }
  });

  it('enqueue flips SIGNED -> SUBMITTED, writes outbox + events', async () => {
    const tenant = await makeTenant('CL-happy');
    const seed = await seedSignedInvoice(admin, tenant, 'HAPPY');
    const gw = makeGateway();

    const { outboxId, reused } = await gw.enqueue(tenant, seed.invoiceId);
    expect(outboxId).toBeTruthy();
    expect(reused).toBe(false);

    const invoiceAfter = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(invoiceAfter[0].status).toBe('SUBMITTED');

    const outbox = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceOutbox).where(eq(clearanceOutbox.id, outboxId)),
    );
    expect(outbox[0].status).toBe('queued');
    expect(outbox[0].idempotencyKey).toBe(seed.documentUuid);
    expect(outbox[0].attempts).toBe(0);

    const events = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    expect(events).toHaveLength(1);
    expect(events[0].fromState).toBe('SIGNED');
    expect(events[0].toState).toBe('SUBMITTED');
    expect(events[0].actor).toBe('system');
  });

  it('enqueue is idempotent on the same invoice', async () => {
    const tenant = await makeTenant('CL-idemp');
    const seed = await seedSignedInvoice(admin, tenant, 'IDEMP');
    const gw = makeGateway();

    const first = await gw.enqueue(tenant, seed.invoiceId);
    const second = await gw.enqueue(tenant, seed.invoiceId);

    expect(second.outboxId).toBe(first.outboxId);
    expect(second.reused).toBe(true);

    const outboxRows = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceOutbox).where(eq(clearanceOutbox.invoiceId, seed.invoiceId)),
    );
    expect(outboxRows).toHaveLength(1);

    const events = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    // Only one SIGNED -> SUBMITTED journal entry.
    expect(events).toHaveLength(1);
  });

  it('drainOnce clears a happy-path submission', async () => {
    const tenant = await makeTenant('CL-drain-ok');
    const seed = await seedSignedInvoice(admin, tenant, 'DRAIN-OK');
    // No archive hook so this test's assertion stays about CLEARED; the
    // CLEARED -> ARCHIVED auto-advance has its own test below.
    const gw = makeGateway(undefined, { archive: null });
    await gw.enqueue(tenant, seed.invoiceId);

    const report = await gw.drainOnce(10);
    expect(report.cleared).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.processed).toBe(1);

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('CLEARED');
    // asp_reference / ota_reference live on the invoices row but aren't
    // modelled in the drizzle schema for the clearance scope — fetch them
    // directly to verify they were persisted.
    const { rows: refs } = await admin.query<{
      asp_reference: string | null;
      ota_reference: string | null;
    }>(`SELECT asp_reference, ota_reference FROM invoices WHERE id = $1`, [seed.invoiceId]);
    expect(refs[0].asp_reference).toMatch(/^stub-asp-/);
    expect(refs[0].ota_reference).toMatch(/^stub-ota-/);

    const outbox = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceOutbox).where(eq(clearanceOutbox.invoiceId, seed.invoiceId)),
    );
    expect(outbox[0].status).toBe('delivered');
    expect(outbox[0].attempts).toBe(1);

    const events = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    const states = events.map((e) => `${e.fromState}->${e.toState}`);
    expect(states).toEqual(['SIGNED->SUBMITTED', 'SUBMITTED->CLEARED']);
  });

  it('drainOnce rejects when ASP returns rejection synchronously', async () => {
    const tenant = await makeTenant('CL-drain-rej');
    const seed = await seedSignedInvoice(admin, tenant, 'DRAIN-REJ', { forceReject: true });
    const gw = makeGateway();
    await gw.enqueue(tenant, seed.invoiceId);

    const report = await gw.drainOnce(10);
    expect(report.rejected).toBe(1);
    expect(report.cleared).toBe(0);

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('REJECTED');

    const events = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    const rejectEvent = events.find((e) => e.toState === 'REJECTED');
    expect(rejectEvent).toBeDefined();
    const raw = rejectEvent?.rawResponse as { rejectionReasons: string[] };
    expect(raw.rejectionReasons[0]).toMatch(/FORCE_REJECT/);
  });

  it('retries once after a transient provider exception, then succeeds', async () => {
    const tenant = await makeTenant('CL-retry');
    const seed = await seedSignedInvoice(admin, tenant, 'RETRY');

    let calls = 0;
    const flaky: TransmissionProvider = {
      async submit(input: TransmissionSubmission): Promise<TransmissionResult> {
        calls += 1;
        if (calls === 1) throw new Error('transient-network-failure');
        return {
          aspReference: `asp-${input.idempotencyKey}`,
          synchronousStatus: 'cleared',
          otaReference: `ota-${input.idempotencyKey}`,
        };
      },
    };

    // No archive hook — this test asserts CLEARED, not ARCHIVED.
    const gw = makeGateway(flaky, { archive: null });
    await gw.enqueue(tenant, seed.invoiceId);

    const first = await gw.drainOnce(10);
    expect(first.retried).toBe(1);

    // Backoff was set 30s out; rewind it so the next drain picks it up.
    await admin.query(
      `UPDATE clearance_outbox SET next_attempt_at = now() - interval '1 second'
        WHERE invoice_id = $1`,
      [seed.invoiceId],
    );

    const second = await gw.drainOnce(10);
    expect(second.cleared).toBe(1);
    expect(calls).toBe(2);

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('CLEARED');

    const outbox = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceOutbox).where(eq(clearanceOutbox.invoiceId, seed.invoiceId)),
    );
    expect(outbox[0].status).toBe('delivered');
    expect(outbox[0].attempts).toBe(2);
  });

  it('moves to DLQ after 5 consecutive failures', async () => {
    const tenant = await makeTenant('CL-dlq');
    const seed = await seedSignedInvoice(admin, tenant, 'DLQ');

    const alwaysFails: TransmissionProvider = {
      async submit(): Promise<TransmissionResult> {
        throw new Error('asp-dead');
      },
    };
    const gw = makeGateway(alwaysFails);
    // Breaker would trip after 3 — reset it after each drain so this test is
    // specifically about the DLQ, not the breaker (that is covered below).
    const breaker = (gw as unknown as { breaker: TransmissionCircuitBreaker }).breaker;

    await gw.enqueue(tenant, seed.invoiceId);

    for (let i = 0; i < 5; i++) {
      await admin.query(
        `UPDATE clearance_outbox SET next_attempt_at = now() - interval '1 second'
          WHERE invoice_id = $1`,
        [seed.invoiceId],
      );
      await gw.drainOnce(10);
      breaker.reset();
    }

    const outbox = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceOutbox).where(eq(clearanceOutbox.invoiceId, seed.invoiceId)),
    );
    expect(outbox[0].status).toBe('dead');
    expect(outbox[0].attempts).toBeGreaterThanOrEqual(5);

    const dlq = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceDlq).where(eq(clearanceDlq.invoiceId, seed.invoiceId)),
    );
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe('asp-dead');

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('SUBMITTED');
  });

  it('circuit breaker opens after 3 consecutive failures and short-circuits subsequent drains', async () => {
    const tenant = await makeTenant('CL-cb');
    // Three distinct invoices so each drain attempt processes a fresh row.
    const seeds = [
      await seedSignedInvoice(admin, tenant, 'CB-1'),
      await seedSignedInvoice(admin, tenant, 'CB-2'),
      await seedSignedInvoice(admin, tenant, 'CB-3'),
      await seedSignedInvoice(admin, tenant, 'CB-4'),
      await seedSignedInvoice(admin, tenant, 'CB-5'),
    ];
    let calls = 0;
    const alwaysFails: TransmissionProvider = {
      async submit(): Promise<TransmissionResult> {
        calls += 1;
        throw new Error('cb-fail');
      },
    };
    const gw = makeGateway(alwaysFails);
    for (const s of seeds) await gw.enqueue(tenant, s.invoiceId);

    // Each drain picks one row (next_attempt_at <= now). After 3 failures the
    // breaker opens.
    for (let i = 0; i < 3; i++) {
      await admin.query(
        `UPDATE clearance_outbox SET next_attempt_at = now() - interval '1 second'
          WHERE tenant_id = $1 AND status = 'queued'`,
        [tenant],
      );
      await gw.drainOnce(1);
    }
    expect(calls).toBe(3);
    const breaker = (gw as unknown as { breaker: TransmissionCircuitBreaker }).breaker;
    expect(breaker.snapshot().isOpen).toBe(true);

    // Open: next two drains must NOT call the provider.
    const callsBefore = calls;
    await admin.query(
      `UPDATE clearance_outbox SET next_attempt_at = now() - interval '1 second'
        WHERE tenant_id = $1 AND status = 'queued'`,
      [tenant],
    );
    const r1 = await gw.drainOnce(5);
    const r2 = await gw.drainOnce(5);
    expect(r1.shortCircuited).toBeGreaterThan(0);
    expect(r2.shortCircuited + r1.shortCircuited).toBeGreaterThan(0);
    expect(calls).toBe(callsBefore);
  });

  it('async callback transitions SUBMITTED -> CLEARED', async () => {
    const tenant = await makeTenant('CL-async');
    const seed = await seedSignedInvoice(admin, tenant, 'ASYNC');

    // Capture the gateway so the stub can sink callbacks back into it.
    // Disable the auto-archive hook so the async-cleared invoice stays in
    // CLEARED for this specific assertion (an archive step would push it
    // onwards to ARCHIVED).
    const gw = makeGateway(undefined, { archive: null });
    const asyncStub = new StubAspProvider({
      handleCallback: (tid, cb) => gw.handleCallback(tid, cb),
    });
    (gw as unknown as { provider: TransmissionProvider }).provider = asyncStub;

    process.env.STUB_ASP_MODE = 'async';
    await gw.enqueue(tenant, seed.invoiceId);
    const report = await gw.drainOnce(10);
    expect(report.pending).toBe(1);

    // Wait for the setTimeout(50ms) callback to fire and process.
    await new Promise((r) => setTimeout(r, 150));

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('CLEARED');

    const events = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    const cbEvent = events.find((e) => e.actor === 'asp_callback');
    expect(cbEvent).toBeDefined();
    expect(cbEvent?.toState).toBe('CLEARED');
  });

  it('handleCallback is idempotent: replaying the same callback is a no-op', async () => {
    const tenant = await makeTenant('CL-cb-idemp');
    const seed = await seedSignedInvoice(admin, tenant, 'CB-IDEMP');

    // Disable auto-archive so the second-callback replay sees CLEARED, not
    // ARCHIVED — this test's assertion is specifically about handleCallback
    // idempotency on a terminal clearance state.
    const gw = makeGateway(undefined, { archive: null });
    const asyncStub = new StubAspProvider({
      handleCallback: (tid, cb) => gw.handleCallback(tid, cb),
    });
    (gw as unknown as { provider: TransmissionProvider }).provider = asyncStub;

    process.env.STUB_ASP_MODE = 'async';
    await gw.enqueue(tenant, seed.invoiceId);
    await gw.drainOnce(10);
    await new Promise((r) => setTimeout(r, 150));

    const before = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    const cbEvent = before.find((e) => e.actor === 'asp_callback');
    expect(cbEvent).toBeDefined();

    // Replay the exact same ASP callback — invoice is already CLEARED, so
    // handleCallback must see the terminal state and no-op.
    await gw.handleCallback(tenant, {
      aspReference: cbEvent!.aspReference!,
      status: 'cleared',
      otaReference: cbEvent!.otaReference ?? undefined,
      rawPayload: {},
    });
    await gw.handleCallback(tenant, {
      aspReference: cbEvent!.aspReference!,
      status: 'rejected',
      rejectionReasons: ['should be ignored'],
      rawPayload: {},
    });

    const after = await withTenant(db, tenant, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, seed.invoiceId)),
    );
    expect(after).toHaveLength(before.length);

    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [seed.invoiceId],
    );
    expect(rows[0].status).toBe('CLEARED');
  });

  it('cross-tenant isolation: tenant A cannot see tenant B outbox under RLS', async () => {
    const tA = await makeTenant('CL-isoA');
    const tB = await makeTenant('CL-isoB');
    const sA = await seedSignedInvoice(admin, tA, 'ISO-A');
    const sB = await seedSignedInvoice(admin, tB, 'ISO-B');
    const gw = makeGateway();
    await gw.enqueue(tA, sA.invoiceId);
    await gw.enqueue(tB, sB.invoiceId);

    const seenByA = await withTenant(db, tA, (tx) => tx.select().from(clearanceOutbox));
    expect(seenByA.every((r) => r.tenantId === tA)).toBe(true);
    expect(seenByA.some((r) => r.invoiceId === sA.invoiceId)).toBe(true);
    expect(seenByA.some((r) => r.invoiceId === sB.invoiceId)).toBe(false);

    const crossFilter = await withTenant(db, tA, (tx) =>
      tx
        .select()
        .from(clearanceOutbox)
        .where(and(eq(clearanceOutbox.tenantId, tB))),
    );
    expect(crossFilter).toHaveLength(0);
  });

  it('handleCallback for an asp_reference that exists in a DIFFERENT tenant does nothing in this tenant (SEC-003)', async () => {
    const tA = await makeTenant('CL-cb-xtA');
    const tB = await makeTenant('CL-cb-xtB');
    const sA = await seedSignedInvoice(admin, tA, 'XT-A');
    const sB = await seedSignedInvoice(admin, tB, 'XT-B');

    // Both tenants' invoices end up SUBMITTED with the SAME asp_reference —
    // the same ASP accidentally reusing a reference, or a crafted callback.
    const sharedRef = `stub-asp-${randomUUID()}`;
    await admin.query(
      `UPDATE invoices SET status='SUBMITTED', asp_reference=$1 WHERE id = ANY($2::uuid[])`,
      [sharedRef, [sA.invoiceId, sB.invoiceId]],
    );

    // No archive hook — we're asserting the status flip itself, not the
    // follow-on ARCHIVED transition.
    const gw = makeGateway(undefined, { archive: null });

    // A callback addressed to tenant A must only affect tenant A's invoice.
    await gw.handleCallback(tA, {
      aspReference: sharedRef,
      status: 'cleared',
      otaReference: 'ota-A',
      rawPayload: { source: 'xt-test' },
    });

    const invA = await admin.query<{ status: string }>(`SELECT status FROM invoices WHERE id=$1`, [
      sA.invoiceId,
    ]);
    expect(invA.rows[0].status).toBe('CLEARED');

    const invB = await admin.query<{ status: string }>(`SELECT status FROM invoices WHERE id=$1`, [
      sB.invoiceId,
    ]);
    // Tenant B's invoice is untouched — RLS stopped the lookup from seeing
    // the row even though the asp_reference matched.
    expect(invB.rows[0].status).toBe('SUBMITTED');

    const eventsB = await withTenant(db, tB, (tx) =>
      tx.select().from(clearanceEvents).where(eq(clearanceEvents.invoiceId, sB.invoiceId)),
    );
    expect(eventsB.find((e) => e.toState === 'CLEARED')).toBeUndefined();
  });

  it('after successful CLEARED drain, invoice auto-advances all the way to ARCHIVED (B1)', async () => {
    const tenant = await makeTenant('CL-archive-hook');
    const seed = await seedSignedInvoice(admin, tenant, 'ARCHIVE-HOOK');

    // ArchiveService is wired by default in makeGateway for this test.
    const gw = makeGateway();
    await gw.enqueue(tenant, seed.invoiceId);

    const report = await gw.drainOnce(10);
    expect(report.cleared).toBe(1);

    const inv = await withTenant(db, tenant, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, seed.invoiceId)),
    );
    expect(inv[0].status).toBe('ARCHIVED');

    const records = await withTenant(db, tenant, (tx) =>
      tx.select().from(archiveRecords).where(eq(archiveRecords.invoiceId, seed.invoiceId)),
    );
    expect(records).toHaveLength(1);
    expect(records[0].tenantId).toBe(tenant);
  });
});
