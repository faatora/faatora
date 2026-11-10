/**
 * EP5 Wave 2 (W2-B) — FirmDashboardService integration tests.
 *
 * Covers:
 *   - Two firms, each with three client tenants; seed invoices across
 *     a mix of statuses and issue dates.
 *   - RLS enforcement: firm A's dashboard aggregates NEVER include firm
 *     B's rows, even though invoice rows belong to tenants that would
 *     otherwise bleed under app.tenant_id.
 *   - Totals: totalInvoices30d, totalVatCollected30dOmr, overdue,
 *     failedClearance, pendingSubmission counts match the seed.
 *   - perClient breakdown row count matches the firm's client tenant
 *     count (zero-activity tenants surface too).
 *   - Issues list surfaces at least one entry for a REJECTED invoice.
 *   - vatReturnsDue has one entry per client tenant.
 *   - The empty-firm case returns an empty shape with totalClients = 0.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { DB } from '../src/db/db.module';
import { FirmDashboardService, type FirmDashboard } from '../src/modules/firms/dashboard.service';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

/** Seed shape per invoice — every invoice gets a party as its supplier + buyer. */
interface SeedInvoice {
  id: string;
  tenantId: string;
  partyId: string;
  number: string;
  status: 'DRAFT' | 'VALIDATED' | 'SIGNED' | 'SUBMITTED' | 'CLEARED' | 'REJECTED' | 'ARCHIVED';
  issueDate: string;
  vatTotal: string;
  grandTotal: string;
}

describe('FirmDashboardService', () => {
  // Two firms, each with three client tenants.
  const firmA = randomUUID();
  const firmB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  // firm A tenants
  const a1 = randomUUID();
  const a2 = randomUUID();
  const a3 = randomUUID();
  // firm B tenants
  const b1 = randomUUID();
  const b2 = randomUUID();
  const b3 = randomUUID();

  // Pre-create parties for every tenant (one each) so invoices have FKs.
  const party = (tid: string): string => partyByTenant[tid];
  const partyByTenant: Record<string, string> = {
    [a1]: randomUUID(),
    [a2]: randomUUID(),
    [a3]: randomUUID(),
    [b1]: randomUUID(),
    [b2]: randomUUID(),
    [b3]: randomUUID(),
  };

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 24 * 60 * 60 * 1000));

  // ---- seed rows, organised by firm so assertions can match totals ----

  // Firm A seed invoices.
  const seedsA: SeedInvoice[] = [
    // a1: three invoices in the 30-day window (various statuses)
    {
      id: randomUUID(),
      tenantId: a1,
      partyId: party(a1),
      number: 'A1-1',
      status: 'CLEARED',
      issueDate: daysAgo(5),
      vatTotal: '10.000',
      grandTotal: '110.000',
    },
    {
      id: randomUUID(),
      tenantId: a1,
      partyId: party(a1),
      number: 'A1-2',
      status: 'SUBMITTED',
      issueDate: daysAgo(10),
      vatTotal: '5.000',
      grandTotal: '55.000',
    },
    {
      id: randomUUID(),
      tenantId: a1,
      partyId: party(a1),
      number: 'A1-3',
      status: 'VALIDATED',
      issueDate: daysAgo(2),
      vatTotal: '2.500',
      grandTotal: '27.500',
    },
    // a2: one older (outside 30d) overdue VALIDATED and one failed (REJECTED) in-window.
    {
      id: randomUUID(),
      tenantId: a2,
      partyId: party(a2),
      number: 'A2-old',
      status: 'VALIDATED',
      issueDate: daysAgo(90),
      vatTotal: '1.000',
      grandTotal: '21.000',
    },
    {
      id: randomUUID(),
      tenantId: a2,
      partyId: party(a2),
      number: 'A2-fail',
      status: 'REJECTED',
      issueDate: daysAgo(3),
      vatTotal: '7.000',
      grandTotal: '77.000',
    },
    // a3: one DRAFT (not counted toward pending submission, which tracks VALIDATED/SIGNED)
    //     and one SIGNED (pending submission, in-window).
    {
      id: randomUUID(),
      tenantId: a3,
      partyId: party(a3),
      number: 'A3-draft',
      status: 'DRAFT',
      issueDate: daysAgo(4),
      vatTotal: '0.500',
      grandTotal: '5.500',
    },
    {
      id: randomUUID(),
      tenantId: a3,
      partyId: party(a3),
      number: 'A3-signed',
      status: 'SIGNED',
      issueDate: daysAgo(1),
      vatTotal: '3.000',
      grandTotal: '33.000',
    },
  ];

  // Firm B seed invoices — kept intentionally distinct so bleed-over
  // would be obvious if RLS failed.
  const seedsB: SeedInvoice[] = [
    {
      id: randomUUID(),
      tenantId: b1,
      partyId: party(b1),
      number: 'B1-1',
      status: 'CLEARED',
      issueDate: daysAgo(5),
      vatTotal: '100.000',
      grandTotal: '1100.000',
    },
    {
      id: randomUUID(),
      tenantId: b2,
      partyId: party(b2),
      number: 'B2-rej',
      status: 'REJECTED',
      issueDate: daysAgo(1),
      vatTotal: '50.000',
      grandTotal: '550.000',
    },
    {
      id: randomUUID(),
      tenantId: b3,
      partyId: party(b3),
      number: 'B3-sub',
      status: 'SUBMITTED',
      issueDate: daysAgo(6),
      vatTotal: '25.000',
      grandTotal: '275.000',
    },
  ];

  let admin: Pool;
  let appPool: Pool;
  let svc: FirmDashboardService;

  async function seedInvoice(inv: SeedInvoice): Promise<void> {
    await admin.query(
      `INSERT INTO invoices (id, tenant_id, number, status, issue_date,
                             supplier_party_id, buyer_party_id,
                             vat_total, grand_total)
         VALUES ($1,$2,$3,$4,$5::date,$6,$6,$7,$8)`,
      [
        inv.id,
        inv.tenantId,
        inv.number,
        inv.status,
        inv.issueDate,
        inv.partyId,
        inv.vatTotal,
        inv.grandTotal,
      ],
    );
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });

    // Users
    await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`, [
      ownerA,
      `sub-${ownerA}`,
      'ownerA-dash@test',
      ownerB,
      `sub-${ownerB}`,
      'ownerB-dash@test',
    ]);
    // Tenants (names in alphabetical order inside each firm)
    await admin.query(
      `INSERT INTO tenants (id, name) VALUES
         ($1,'Dash-A-1 Alpha'),($2,'Dash-A-2 Beta'),($3,'Dash-A-3 Gamma'),
         ($4,'Dash-B-1 Delta'),($5,'Dash-B-2 Echo'),($6,'Dash-B-3 Foxtrot')`,
      [a1, a2, a3, b1, b2, b3],
    );
    // Firms
    await admin.query(`INSERT INTO firms (id, name) VALUES ($1,'DashFirmA'),($2,'DashFirmB')`, [
      firmA,
      firmB,
    ]);
    await admin.query(
      `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [firmA, ownerA, firmB, ownerB],
    );
    await admin.query(
      `INSERT INTO firm_client_tenants (firm_id, tenant_id, access_level, engagement_type) VALUES
         ($1,$2,'full','ongoing'),($1,$3,'full','ongoing'),($1,$4,'full','ongoing'),
         ($5,$6,'full','ongoing'),($5,$7,'full','ongoing'),($5,$8,'full','ongoing')`,
      [firmA, a1, a2, a3, firmB, b1, b2, b3],
    );
    // Parties (one per tenant)
    const partyRows: Array<[string, string]> = Object.entries(partyByTenant).map(([tid, pid]) => [
      pid,
      tid,
    ]);
    for (const [pid, tid] of partyRows) {
      await admin.query(
        `INSERT INTO parties (id, tenant_id, kind, name) VALUES ($1,$2,'customer',$3)`,
        [pid, tid, `Party-${tid}`],
      );
    }
    // Invoices
    for (const s of [...seedsA, ...seedsB]) await seedInvoice(s);

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      providers: [FirmDashboardService, { provide: DB, useValue: appDb }],
    }).compile();
    svc = moduleRef.get(FirmDashboardService);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2,$3,$4,$5,$6)`, [
      a1,
      a2,
      a3,
      b1,
      b2,
      b3,
    ]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2,$3,$4,$5,$6)`, [
      a1,
      a2,
      a3,
      b1,
      b2,
      b3,
    ]);
    await admin.query(`DELETE FROM firms WHERE id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3,$4,$5,$6)`, [
      a1,
      a2,
      a3,
      b1,
      b2,
      b3,
    ]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerA, ownerB]);
    await appPool.end();
    await admin.end();
  });

  let dashA: FirmDashboard;
  let dashB: FirmDashboard;
  beforeAll(async () => {
    // Compute once; most assertions read from these.
    dashA = await svc.getDashboard(firmA);
    dashB = await svc.getDashboard(firmB);
  });

  describe('summary totals', () => {
    it('reports totalClients equal to the seeded active links for each firm', () => {
      expect(dashA.summary.totalClients).toBe(3);
      expect(dashB.summary.totalClients).toBe(3);
    });

    it('counts totalInvoices30d only within the rolling 30-day window', () => {
      // seedsA: a1 has 3, a2 has 1 in-window (the REJECTED), a3 has 2 — total 6
      // in-window for A (A2-old is 90d ago and excluded).
      expect(dashA.summary.totalInvoices30d).toBe(6);
      expect(dashB.summary.totalInvoices30d).toBe(3);
    });

    it('sums totalVatCollected30dOmr across all firm tenants', () => {
      // A in-window VAT: 10 + 5 + 2.5 + 7 + 0.5 + 3 = 28.000
      expect(Number(dashA.summary.totalVatCollected30dOmr)).toBeCloseTo(28, 3);
      // B in-window VAT: 100 + 50 + 25 = 175.000
      expect(Number(dashB.summary.totalVatCollected30dOmr)).toBeCloseTo(175, 3);
    });

    it('counts failedClearanceCount as REJECTED invoices', () => {
      expect(dashA.summary.failedClearanceCount).toBe(1);
      expect(dashB.summary.failedClearanceCount).toBe(1);
    });

    it('counts pendingSubmissionCount as VALIDATED/SIGNED invoices', () => {
      // A: A1-3 VALIDATED, A2-old VALIDATED, A3-signed SIGNED = 3
      expect(dashA.summary.pendingSubmissionCount).toBe(3);
      // B: none
      expect(dashB.summary.pendingSubmissionCount).toBe(0);
    });

    it('counts overdueInvoiceCount as not-completed invoices older than 30 days', () => {
      // A: A2-old (VALIDATED, 90d) — exactly one.
      expect(dashA.summary.overdueInvoiceCount).toBe(1);
      // B: none older than 30d.
      expect(dashB.summary.overdueInvoiceCount).toBe(0);
    });

    it('reports upcomingVatReturnCount equal to the firm client count', () => {
      expect(dashA.summary.upcomingVatReturnCount).toBe(3);
      expect(dashB.summary.upcomingVatReturnCount).toBe(3);
    });
  });

  describe('perClient breakdown', () => {
    it('has one row per active client tenant (zero-activity tenants included)', () => {
      expect(dashA.perClient).toHaveLength(3);
      const tenantIds = dashA.perClient.map((r) => r.tenantId).sort();
      expect(tenantIds).toEqual([a1, a2, a3].sort());
      expect(dashB.perClient).toHaveLength(3);
    });

    it('fills tenantName from the tenants table', () => {
      const names = dashA.perClient.map((r) => r.tenantName);
      expect(names).toContain('Dash-A-1 Alpha');
      expect(names).toContain('Dash-A-2 Beta');
      expect(names).toContain('Dash-A-3 Gamma');
    });

    it('reports invoices30d and vatCollected30dOmr per tenant, matching the seed', () => {
      const byId = Object.fromEntries(dashA.perClient.map((r) => [r.tenantId, r] as const));
      expect(byId[a1].invoices30d).toBe(3);
      expect(Number(byId[a1].vatCollected30dOmr)).toBeCloseTo(17.5, 3);
      expect(byId[a2].invoices30d).toBe(1); // A2-old is out of window
      expect(Number(byId[a2].vatCollected30dOmr)).toBeCloseTo(7, 3);
      expect(byId[a3].invoices30d).toBe(2);
      expect(Number(byId[a3].vatCollected30dOmr)).toBeCloseTo(3.5, 3);
    });

    it('reports lastSubmissionAt only for tenants with SUBMITTED invoices', () => {
      const byId = Object.fromEntries(dashA.perClient.map((r) => [r.tenantId, r] as const));
      expect(byId[a1].lastSubmissionAt).toBeTruthy(); // A1-2 was SUBMITTED
      expect(byId[a2].lastSubmissionAt).toBeNull();
      expect(byId[a3].lastSubmissionAt).toBeNull();
    });

    it('reports openIssues per tenant (REJECTED + overdue in-flight)', () => {
      const byId = Object.fromEntries(dashA.perClient.map((r) => [r.tenantId, r] as const));
      // a1: no REJECTED, no overdue
      expect(byId[a1].openIssues).toBe(0);
      // a2: one REJECTED + one overdue VALIDATED = 2
      expect(byId[a2].openIssues).toBe(2);
      // a3: no REJECTED, no overdue
      expect(byId[a3].openIssues).toBe(0);
    });
  });

  describe('issues list', () => {
    it('surfaces at least one issue when a seeded invoice is REJECTED', () => {
      // A has A2-fail REJECTED — expect it in the list with severity error.
      const hasReject = dashA.issues.some(
        (i) =>
          i.severity === 'error' && i.invoiceId === seedsA.find((s) => s.number === 'A2-fail')!.id,
      );
      expect(hasReject).toBe(true);
    });

    it('is bounded at 20 entries', () => {
      expect(dashA.issues.length).toBeLessThanOrEqual(20);
      expect(dashB.issues.length).toBeLessThanOrEqual(20);
    });

    it('populates tenantId + invoiceId + ISO createdAt on each issue', () => {
      for (const i of dashA.issues) {
        expect(typeof i.tenantId).toBe('string');
        expect(typeof i.invoiceId).toBe('string');
        expect(new Date(i.createdAt).toString()).not.toBe('Invalid Date');
      }
    });
  });

  describe('vatReturnsDue', () => {
    it('produces one entry per client tenant with the current quarter window', () => {
      expect(dashA.vatReturnsDue).toHaveLength(3);
      for (const v of dashA.vatReturnsDue) {
        expect(v.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(v.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(v.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['draft', 'submitted', 'overdue']).toContain(v.status);
        // periodEnd must come after periodStart
        expect(v.periodEnd >= v.periodStart).toBe(true);
      }
    });
  });

  describe('cross-firm RLS isolation', () => {
    it('firm A dashboard aggregates never include any firm B invoice', () => {
      const firmBInvoiceIds = seedsB.map((s) => s.id);
      const aIssueInvoiceIds = dashA.issues.map((i) => i.invoiceId!);
      for (const bId of firmBInvoiceIds) {
        expect(aIssueInvoiceIds).not.toContain(bId);
      }
      const aTenantIds = dashA.perClient.map((r) => r.tenantId);
      for (const bt of [b1, b2, b3]) expect(aTenantIds).not.toContain(bt);
    });

    it('firm B dashboard aggregates never include any firm A invoice', () => {
      const firmAInvoiceIds = seedsA.map((s) => s.id);
      const bIssueInvoiceIds = dashB.issues.map((i) => i.invoiceId!);
      for (const aId of firmAInvoiceIds) {
        expect(bIssueInvoiceIds).not.toContain(aId);
      }
      const bTenantIds = dashB.perClient.map((r) => r.tenantId);
      for (const at of [a1, a2, a3]) expect(bTenantIds).not.toContain(at);
    });

    it('cross-tenant aggregate totals match the seeded firm partition exactly', () => {
      // If RLS leaked B rows into A's SUM, A's totals would include some
      // of B's larger-magnitude VAT (100 / 50 / 25). Guard against that.
      expect(Number(dashA.summary.totalVatCollected30dOmr)).toBeLessThan(100);
      expect(Number(dashB.summary.totalVatCollected30dOmr)).toBeGreaterThan(100);
    });
  });

  describe('empty-firm case', () => {
    it('returns an empty shape when the firm has no client tenants', async () => {
      const emptyFirm = randomUUID();
      const emptyOwner = randomUUID();
      await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3)`, [
        emptyOwner,
        `sub-${emptyOwner}`,
        'empty-owner@test',
      ]);
      await admin.query(`INSERT INTO firms (id, name) VALUES ($1,'DashFirmEmpty')`, [emptyFirm]);
      await admin.query(
        `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner')`,
        [emptyFirm, emptyOwner],
      );
      try {
        const d = await svc.getDashboard(emptyFirm);
        expect(d.summary.totalClients).toBe(0);
        expect(d.summary.totalInvoices30d).toBe(0);
        expect(d.summary.upcomingVatReturnCount).toBe(0);
        expect(d.perClient).toEqual([]);
        expect(d.issues).toEqual([]);
        expect(d.vatReturnsDue).toEqual([]);
      } finally {
        await admin.query(`DELETE FROM firms WHERE id=$1`, [emptyFirm]);
        await admin.query(`DELETE FROM users WHERE id=$1`, [emptyOwner]);
      }
    });
  });
});
