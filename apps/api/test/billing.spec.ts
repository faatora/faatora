import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../src/db/schema';
import { withTenant } from '../src/db/with-tenant';
import { PlansService } from '../src/modules/billing/plans.service';
import { SubscriptionsService, addOneMonth } from '../src/modules/billing/subscriptions.service';
import { MeteringService } from '../src/modules/billing/metering.service';
import { CommissionsService } from '../src/modules/billing/commissions.service';
import { BillingService, computeBilling } from '../src/modules/billing/billing.service';
import {
  billingInvoices,
  plans,
  resellerCommissions,
  subscriptions,
  usageMeters,
} from '../src/db/schema/billing';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

type AppDb = ReturnType<typeof drizzle<typeof schema>>;

describe('Billing', () => {
  let admin: Pool;
  let appPool: Pool;
  let db: AppDb;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];
  const createdFirms: string[] = [];

  // Services
  let plansSvc: PlansService;
  let subsSvc: SubscriptionsService;
  let meteringSvc: MeteringService;
  let commissionsSvc: CommissionsService;
  let billingSvc: BillingService;

  async function makeTenant(name: string): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [id, name]);
    createdTenants.push(id);
    return id;
  }

  async function makeUser(email: string): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, cognito_sub, email) VALUES ($1, $2, $3)', [
      id,
      `sub-${id}`,
      email,
    ]);
    createdUsers.push(id);
    return id;
  }

  beforeAll(() => {
    admin = new Pool({ connectionString: ADMIN_URL });
    appPool = new Pool({ connectionString: APP_URL });
    db = drizzle(appPool, { schema });
    plansSvc = new PlansService(db);
    subsSvc = new SubscriptionsService(db, plansSvc);
    meteringSvc = new MeteringService(db);
    commissionsSvc = new CommissionsService(db);
    billingSvc = new BillingService(db, commissionsSvc);
  });

  afterAll(async () => {
    if (createdFirms.length) {
      await admin.query(`DELETE FROM accountant_firms WHERE id = ANY($1::uuid[])`, [createdFirms]);
    }
    if (createdTenants.length) {
      await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [createdTenants]);
    }
    if (createdUsers.length) {
      await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUsers]);
    }
    await appPool.end();
    await admin.end();
  });

  describe('plans catalog', () => {
    it('seeds basic and pro with correct monthly fees', async () => {
      const all = await plansSvc.list();
      const byCode = Object.fromEntries(all.map((p) => [p.code, p]));
      expect(byCode.basic).toBeDefined();
      expect(byCode.pro).toBeDefined();
      expect(Number(byCode.basic.monthlyFee)).toBe(12);
      expect(byCode.basic.includedInvoices).toBe(100);
      expect(Number(byCode.basic.overagePricePerInvoice)).toBe(0.03);
      expect(Number(byCode.pro.monthlyFee)).toBe(25);
      expect(byCode.pro.includedInvoices).toBe(500);
      expect(Number(byCode.pro.overagePricePerInvoice)).toBe(0.025);
      expect(byCode.basic.currency).toBe('OMR');
    });

    it('getByCode returns the matching plan', async () => {
      const p = await plansSvc.getByCode('pro');
      expect(p.code).toBe('pro');
    });
  });

  describe('subscriptions', () => {
    it('subscribe sets current_period_end exactly one month after start', async () => {
      const tenantId = await makeTenant('T-sub-1');
      const sub = await subsSvc.subscribe(tenantId, 'basic');
      expect(sub.status).toBe('active');
      expect(sub.plan.code).toBe('basic');
      const start = new Date(sub.currentPeriodStart);
      const end = new Date(sub.currentPeriodEnd);
      // addOneMonth is month-accurate (handles overflow); check both algebraically and via helper.
      expect(end.getTime()).toBe(addOneMonth(start).getTime());
      // Also a sanity check: end is between 28 and 32 days after start.
      const diffDays = (end.getTime() - start.getTime()) / (24 * 3600 * 1000);
      expect(diffDays).toBeGreaterThanOrEqual(28);
      expect(diffDays).toBeLessThanOrEqual(32);
    });

    it('subscribe twice swaps the plan without creating a new row', async () => {
      const tenantId = await makeTenant('T-sub-2');
      await subsSvc.subscribe(tenantId, 'basic');
      const after = await subsSvc.subscribe(tenantId, 'pro');
      expect(after.plan.code).toBe('pro');
      const rows = await withTenant(db, tenantId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('metering', () => {
    it('increment is idempotent on upsert conflict (same tenant+period+metric accumulates)', async () => {
      const tenantId = await makeTenant('T-meter');
      await subsSvc.subscribe(tenantId, 'basic');
      const sub = await subsSvc.getActive(tenantId);
      const periodStart = new Date(sub!.currentPeriodStart);
      const periodEnd = new Date(sub!.currentPeriodEnd);

      const a = await meteringSvc.increment(tenantId, 'invoices_issued', periodStart, periodEnd);
      const b = await meteringSvc.increment(tenantId, 'invoices_issued', periodStart, periodEnd);
      const c = await meteringSvc.increment(tenantId, 'invoices_issued', periodStart, periodEnd, 3);
      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(c).toBe(5);

      // Exactly one row for (tenant, period, metric).
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(usageMeters)
          .where(
            and(
              eq(usageMeters.tenantId, tenantId),
              eq(usageMeters.metric, 'invoices_issued'),
              eq(usageMeters.periodStart, periodStart),
            ),
          ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(5);

      const got = await meteringSvc.getUsage(tenantId, 'invoices_issued', periodStart, periodEnd);
      expect(got).toBe(5);
    });

    it('onInvoiceIssued increments the current subscription period meter', async () => {
      const tenantId = await makeTenant('T-meter-ii');
      await subsSvc.subscribe(tenantId, 'basic');
      const n1 = await meteringSvc.onInvoiceIssued(tenantId);
      const n2 = await meteringSvc.onInvoiceIssued(tenantId);
      expect(n1).toBe(1);
      expect(n2).toBe(2);
    });
  });

  describe('computeBilling (pure)', () => {
    it('150 invoices on basic produces subtotal 13.500, VAT 0.675, total 14.175', () => {
      const c = computeBilling({
        used: 150,
        included: 100,
        monthlyFee: 12,
        overagePrice: 0.03,
      });
      expect(c.planFee).toBe(12);
      expect(c.overageFee).toBe(1.5);
      expect(c.subtotal).toBe(13.5);
      expect(c.vat).toBe(0.675);
      expect(c.total).toBe(14.175);
    });

    it('usage within included invoices has zero overage', () => {
      const c = computeBilling({
        used: 50,
        included: 100,
        monthlyFee: 12,
        overagePrice: 0.03,
      });
      expect(c.overageFee).toBe(0);
      expect(c.subtotal).toBe(12);
      expect(c.total).toBe(12.6);
    });
  });

  describe('generateMonthlyBilling', () => {
    it('writes a billing_invoice with 13.500 / 0.675 / 14.175 for 150 invoices on basic', async () => {
      const tenantId = await makeTenant('T-bill-150');
      await subsSvc.subscribe(tenantId, 'basic');
      const sub = await subsSvc.getActive(tenantId);
      const periodStart = new Date(sub!.currentPeriodStart);
      const periodEnd = new Date(sub!.currentPeriodEnd);
      await meteringSvc.increment(tenantId, 'invoices_issued', periodStart, periodEnd, 150);

      const inv = await billingSvc.generateMonthlyBilling(tenantId);
      expect(Number(inv.planFee)).toBe(12);
      expect(Number(inv.overageFee)).toBe(1.5);
      expect(Number(inv.subtotal)).toBe(13.5);
      expect(Number(inv.vat)).toBe(0.675);
      expect(Number(inv.total)).toBe(14.175);
      expect(inv.status).toBe('open');
      expect(inv.currency).toBe('OMR');
      expect(inv.computation.used).toBe(150);
      expect(inv.computation.overageUnits).toBe(50);
    });

    it('markPaid flips status and sets paid_at', async () => {
      const tenantId = await makeTenant('T-bill-paid');
      await subsSvc.subscribe(tenantId, 'basic');
      const inv = await billingSvc.generateMonthlyBilling(tenantId);
      const paid = await billingSvc.markPaid(tenantId, inv.id);
      expect(paid.status).toBe('paid');
      expect(paid.paidAt).toBeTruthy();
    });
  });

  describe('commission accrual', () => {
    it('accrues 20% of subtotal when the tenant has a referred=true accountant link', async () => {
      const tenantId = await makeTenant('T-comm-ref');
      const ownerUserId = await makeUser(`accountant-${tenantId}@x`);
      const firmId = randomUUID();
      createdFirms.push(firmId);
      await admin.query(
        `INSERT INTO accountant_firms (id, owner_user_id, name, commission_rate)
         VALUES ($1, $2, $3, $4)`,
        [firmId, ownerUserId, 'Al-Haitham Audit', 0.2],
      );
      await admin.query(
        `INSERT INTO accountant_client_links (firm_id, tenant_id, referred) VALUES ($1, $2, true)`,
        [firmId, tenantId],
      );

      await subsSvc.subscribe(tenantId, 'basic');
      const sub = await subsSvc.getActive(tenantId);
      await meteringSvc.increment(
        tenantId,
        'invoices_issued',
        new Date(sub!.currentPeriodStart),
        new Date(sub!.currentPeriodEnd),
        150,
      );
      const inv = await billingSvc.generateMonthlyBilling(tenantId);

      const commissions = await db
        .select()
        .from(resellerCommissions)
        .where(eq(resellerCommissions.billingInvoiceId, inv.id));
      expect(commissions).toHaveLength(1);
      expect(commissions[0].firmId).toBe(firmId);
      // 20% of subtotal 13.5 = 2.7
      expect(Number(commissions[0].amount)).toBeCloseTo(2.7, 3);
      expect(commissions[0].status).toBe('accrued');
    });

    it('skips accrual when no referred link exists', async () => {
      const tenantId = await makeTenant('T-comm-none');
      await subsSvc.subscribe(tenantId, 'basic');
      const inv = await billingSvc.generateMonthlyBilling(tenantId);
      const commissions = await db
        .select()
        .from(resellerCommissions)
        .where(eq(resellerCommissions.billingInvoiceId, inv.id));
      expect(commissions).toHaveLength(0);
    });

    it('skips accrual when link exists but referred=false', async () => {
      const tenantId = await makeTenant('T-comm-notref');
      const ownerUserId = await makeUser(`acc2-${tenantId}@x`);
      const firmId = randomUUID();
      createdFirms.push(firmId);
      await admin.query(
        `INSERT INTO accountant_firms (id, owner_user_id, name) VALUES ($1, $2, $3)`,
        [firmId, ownerUserId, 'No-Ref Firm'],
      );
      await admin.query(
        `INSERT INTO accountant_client_links (firm_id, tenant_id, referred) VALUES ($1, $2, false)`,
        [firmId, tenantId],
      );
      await subsSvc.subscribe(tenantId, 'basic');
      const inv = await billingSvc.generateMonthlyBilling(tenantId);
      const commissions = await db
        .select()
        .from(resellerCommissions)
        .where(eq(resellerCommissions.billingInvoiceId, inv.id));
      expect(commissions).toHaveLength(0);
    });
  });

  describe('cross-tenant isolation', () => {
    it('tenant A cannot see tenant B subscription under RLS', async () => {
      const tA = await makeTenant('T-iso-A');
      const tB = await makeTenant('T-iso-B');
      await subsSvc.subscribe(tA, 'basic');
      await subsSvc.subscribe(tB, 'pro');

      const seenByA = await withTenant(db, tA, (tx) => tx.select().from(subscriptions));
      expect(seenByA).toHaveLength(1);
      expect(seenByA[0].tenantId).toBe(tA);

      // Explicit filter for the other tenant's id must still return nothing.
      const crossFilter = await withTenant(db, tA, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tB)),
      );
      expect(crossFilter).toHaveLength(0);
    });

    it('cross-tenant insert is blocked by RLS WITH CHECK', async () => {
      const tA = await makeTenant('T-iso-C');
      const tB = await makeTenant('T-iso-D');
      const basic = await plansSvc.getByCode('basic');
      await expect(
        withTenant(db, tA, (tx) =>
          tx.insert(subscriptions).values({
            tenantId: tB,
            planId: basic.id,
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          }),
        ),
      ).rejects.toThrow();
    });

    it('billing_invoices from tenant B are invisible to tenant A', async () => {
      const tA = await makeTenant('T-iso-E');
      const tB = await makeTenant('T-iso-F');
      await subsSvc.subscribe(tA, 'basic');
      await subsSvc.subscribe(tB, 'basic');
      await billingSvc.generateMonthlyBilling(tA);
      await billingSvc.generateMonthlyBilling(tB);
      const seenByA = await withTenant(db, tA, (tx) => tx.select().from(billingInvoices));
      expect(seenByA.every((r) => r.tenantId === tA)).toBe(true);
      expect(seenByA.length).toBeGreaterThan(0);
    });
  });

  it('plans are visible without a tenant context (public catalog)', async () => {
    // Direct read with no app.tenant_id set.
    const rows = await db.select().from(plans);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
