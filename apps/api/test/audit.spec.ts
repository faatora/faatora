/**
 * EP5 Wave 2 (W2-E) — AuditService + subscribers.
 *
 * Covers:
 *   - record + list round-trip
 *   - cross-firm isolation (firm A cannot list firm B's events)
 *   - exportForTenant filters on tenant + period
 *   - every @OnEvent subscriber persists a matching audit row
 *   - defensive posture: a failing audit record never throws back into
 *     the emitter
 *   - FirmsService.createFirm → firm.created → audit row
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DB } from '../src/db/db.module';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuditSubscribers } from '../src/modules/audit/audit.subscribers';
import { FirmsService } from '../src/modules/firms/firms.service';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('AuditService (EP5 W2-E)', () => {
  const ownerU = randomUUID();
  const strangerU = randomUUID();
  const tA = randomUUID();
  const tB = randomUUID();

  let admin: Pool;
  let appPool: Pool;
  let audit: AuditService;
  let subscribers: AuditSubscribers;
  let firms: FirmsService;
  let events: EventEmitter2;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES
         ($1,$2,$3),($4,$5,$6)`,
      [
        ownerU,
        `sub-${ownerU}`,
        `owner-${ownerU}@test`,
        strangerU,
        `sub-${strangerU}`,
        `stranger-${strangerU}@test`,
      ],
    );
    await admin.query(
      `INSERT INTO tenants (id, name) VALUES ($1,'AuditT One'),($2,'AuditT Two')`,
      [tA, tB],
    );

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [AuditService, AuditSubscribers, FirmsService, { provide: DB, useValue: appDb }],
    }).compile();
    audit = moduleRef.get(AuditService);
    subscribers = moduleRef.get(AuditSubscribers);
    firms = moduleRef.get(FirmsService);
    events = moduleRef.get(EventEmitter2);
    // Nest @OnEvent handlers are wired at application init; in a
    // compiled TestingModule we must call init() for them to register.
    const app = moduleRef.createNestApplication();
    await app.init();
    // Replace the module refs with the initialised application's instances
    // so handlers subscribed against the right EventEmitter2.
    audit = app.get(AuditService);
    subscribers = app.get(AuditSubscribers);
    firms = app.get(FirmsService);
    events = app.get(EventEmitter2);
    void subscribers; // referenced for side-effect: register @OnEvents
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM firm_audit_events WHERE event_type LIKE 'audit.test.%'`);
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Audit Firm%'`);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tA, tB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerU, strangerU]);
    await (firms as unknown as { onModuleDestroy(): Promise<void> }).onModuleDestroy();
    await appPool.end();
    await admin.end();
  });

  afterEach(async () => {
    // Cascade-delete firms wipes their audit rows too.
    await admin.query(`DELETE FROM firms WHERE name LIKE 'Audit Firm%'`);
  });

  describe('record / list round-trip', () => {
    it('record() inserts a firm-scoped row and list() returns it', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm 1' });
      const got = await audit.record({
        firmId: firm.id,
        actorUserId: ownerU,
        eventType: 'audit.test.record',
        payload: { thing: 'value' },
      });
      expect(got.id).toBeDefined();
      expect(got.eventType).toBe('audit.test.record');
      expect(got.firmId).toBe(firm.id);
      expect(got.payload).toEqual({ thing: 'value' });
      expect(got.source).toBe('system');

      // List (the firm.created emit from createFirm also lands here).
      const list = await audit.list(firm.id, { limit: 50 });
      expect(list.find((r) => r.id === got.id)).toBeTruthy();
    });

    it('list() orders by occurred_at DESC and respects limit', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm 2' });
      // Insert three rows with manual payloads so we can tell them apart.
      for (const i of [1, 2, 3]) {
        await audit.record({
          firmId: firm.id,
          eventType: 'audit.test.ordered',
          payload: { i },
        });
      }
      const list = await audit.list(firm.id, { limit: 2, eventType: 'audit.test.ordered' });
      expect(list).toHaveLength(2);
      // DESC means the most recently inserted is first.
      expect((list[0].payload as { i: number }).i).toBe(3);
      expect((list[1].payload as { i: number }).i).toBe(2);
    });

    it('list() filters by eventType', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm 3' });
      await audit.record({ firmId: firm.id, eventType: 'audit.test.a' });
      await audit.record({ firmId: firm.id, eventType: 'audit.test.b' });
      const onlyA = await audit.list(firm.id, { eventType: 'audit.test.a' });
      expect(onlyA.every((r) => r.eventType === 'audit.test.a')).toBe(true);
    });

    it('list() with a "since" filter drops older rows', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm 4' });
      const old = await audit.record({ firmId: firm.id, eventType: 'audit.test.old' });
      // Rewind the older row's timestamp via admin.
      await admin.query(
        `UPDATE firm_audit_events SET occurred_at = now() - interval '2 days' WHERE id=$1`,
        [old.id],
      );
      await audit.record({ firmId: firm.id, eventType: 'audit.test.new' });
      const since = new Date(Date.now() - 60 * 60 * 1000); // one hour ago
      const list = await audit.list(firm.id, { since });
      expect(list.find((r) => r.id === old.id)).toBeUndefined();
      expect(list.some((r) => r.eventType === 'audit.test.new')).toBe(true);
    });
  });

  describe('cross-firm isolation', () => {
    it('firm A cannot list firm B audit events', async () => {
      const firmA = await firms.createFirm(ownerU, { name: 'Audit Firm A-iso' });
      const firmB = await firms.createFirm(strangerU, { name: 'Audit Firm B-iso' });
      await audit.record({ firmId: firmA.id, eventType: 'audit.test.a-only' });
      await audit.record({ firmId: firmB.id, eventType: 'audit.test.b-only' });
      const listA = await audit.list(firmA.id);
      expect(listA.some((r) => r.eventType === 'audit.test.b-only')).toBe(false);
      const listB = await audit.list(firmB.id);
      expect(listB.some((r) => r.eventType === 'audit.test.a-only')).toBe(false);
    });

    it('RLS blocks a raw query that tries to read another firm', async () => {
      const firmA = await firms.createFirm(ownerU, { name: 'Audit Firm A-rls' });
      const firmB = await firms.createFirm(strangerU, { name: 'Audit Firm B-rls' });
      await audit.record({ firmId: firmA.id, eventType: 'audit.test.rlsA' });
      await audit.record({ firmId: firmB.id, eventType: 'audit.test.rlsB' });
      const client = await appPool.connect();
      try {
        await client.query(`select set_config('app.firm_id', $1, false)`, [firmA.id]);
        const { rows } = await client.query<{ event_type: string }>(
          `SELECT event_type FROM firm_audit_events WHERE event_type LIKE 'audit.test.rls%'`,
        );
        expect(rows.every((r) => r.event_type === 'audit.test.rlsA')).toBe(true);
      } finally {
        await client.query(`select set_config('app.firm_id', '', false)`);
        client.release();
      }
    });
  });

  describe('exportForTenant', () => {
    it('returns only rows for (firm, tenant) within the period', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Export' });
      // Three rows: in-period A, in-period B, out-of-period A.
      const inA = await audit.record({
        firmId: firm.id,
        tenantId: tA,
        eventType: 'audit.test.export.inA',
      });
      await audit.record({
        firmId: firm.id,
        tenantId: tB,
        eventType: 'audit.test.export.inB',
      });
      const outA = await audit.record({
        firmId: firm.id,
        tenantId: tA,
        eventType: 'audit.test.export.outA',
      });
      // Rewind the "out" row's timestamp to a year ago.
      await admin.query(
        `UPDATE firm_audit_events SET occurred_at = now() - interval '365 days' WHERE id=$1`,
        [outA.id],
      );
      const periodStart = new Date(Date.now() - 60 * 60 * 1000);
      const periodEnd = new Date(Date.now() + 60 * 60 * 1000);
      const rows = await audit.exportForTenant(firm.id, tA, periodStart, periodEnd);
      expect(rows.find((r) => r.id === inA.id)).toBeTruthy();
      expect(rows.find((r) => r.id === outA.id)).toBeUndefined();
      expect(rows.every((r) => r.tenantId === tA)).toBe(true);
    });
  });

  describe('event subscribers', () => {
    it('firm.client.added emits → an audit row is persisted', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Client-Added' });
      events.emit('firm.client.added', {
        firmId: firm.id,
        tenantId: tA,
        createdByUserId: ownerU,
      });
      // The subscriber is `promisify: true, async: true`, but emit() is
      // fire-and-forget; wait briefly for the DB write to settle.
      await waitFor(async () => {
        const list = await audit.list(firm.id, { eventType: 'firm.client.added' });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'firm.client.added' });
      expect(list[0].firmId).toBe(firm.id);
      expect(list[0].tenantId).toBe(tA);
      expect(list[0].actorUserId).toBe(ownerU);
    });

    it('firm.client.revoked emits → an audit row is persisted with actor', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Client-Revoked' });
      events.emit('firm.client.revoked', {
        firmId: firm.id,
        tenantId: tA,
        revokedByUserId: ownerU,
      });
      await waitFor(async () => {
        const list = await audit.list(firm.id, { eventType: 'firm.client.revoked' });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'firm.client.revoked' });
      expect(list[0].tenantId).toBe(tA);
      expect(list[0].actorUserId).toBe(ownerU);
    });

    it('firm.import.committed emits → an audit row records the row count', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Import' });
      events.emit('firm.import.committed', {
        firmId: firm.id,
        tenantId: tA,
        batchId: 'batch-xyz',
        rowCount: 42,
        actorUserId: ownerU,
      });
      await waitFor(async () => {
        const list = await audit.list(firm.id, { eventType: 'firm.import.committed' });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'firm.import.committed' });
      expect(list[0].payload).toMatchObject({ batchId: 'batch-xyz', rowCount: 42 });
    });

    it('billing.customer.created emits → an audit row records the provider', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Billing' });
      events.emit('billing.customer.created', {
        firmId: firm.id,
        provider: 'stripe',
        providerCustomerId: 'cus_abc123',
      });
      await waitFor(async () => {
        const list = await audit.list(firm.id, { eventType: 'billing.customer.created' });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'billing.customer.created' });
      expect(list[0].payload).toMatchObject({
        provider: 'stripe',
        providerCustomerId: 'cus_abc123',
      });
    });

    it('billing.subscription.updated without firmId is dropped', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Sub-NoFirm' });
      // Emit WITHOUT firmId: should be silently dropped by the subscriber.
      events.emit('billing.subscription.updated', {
        provider: 'stripe',
        providerSubscriptionId: 'sub_1',
        status: 'active',
      });
      // Also emit a well-formed one to anchor the wait.
      events.emit('billing.subscription.updated', {
        firmId: firm.id,
        provider: 'stripe',
        providerSubscriptionId: 'sub_2',
        status: 'active',
      });
      await waitFor(async () => {
        const list = await audit.list(firm.id, {
          eventType: 'billing.subscription.updated',
        });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'billing.subscription.updated' });
      // Only the well-formed one was persisted.
      expect(list).toHaveLength(1);
      expect(list[0].payload).toMatchObject({ providerSubscriptionId: 'sub_2' });
    });

    it('FirmsService.createFirm fires firm.created → an audit row with the owner', async () => {
      const firm = await firms.createFirm(ownerU, { name: 'Audit Firm Auto-Created' });
      await waitFor(async () => {
        const list = await audit.list(firm.id, { eventType: 'firm.created' });
        return list.length >= 1;
      });
      const list = await audit.list(firm.id, { eventType: 'firm.created' });
      expect(list[0].actorUserId).toBe(ownerU);
      expect(list[0].payload).toMatchObject({ firmName: 'Audit Firm Auto-Created' });
    });

    it('a failing audit write does not throw back to the emitter (defensive subscriber)', async () => {
      // No way to make the DB throw deterministically without mocking,
      // so we drive the subscriber directly with an impossible firmId.
      // The subscriber must swallow the error.
      await expect(
        subscribers.onFirmClientAdded({
          firmId: '00000000-0000-0000-0000-000000000000',
          tenantId: tA,
          createdByUserId: ownerU,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

/**
 * Poll `cond` every 10ms up to 2s. Nest's @OnEvent with promisify:true
 * returns a Promise but emit() itself does not await it, so tests that
 * depend on the handler finishing a DB write have to wait.
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
