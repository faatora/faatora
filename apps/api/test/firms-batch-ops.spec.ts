/**
 * EP5 Wave 2 (W2-C) -- BatchOperationsService tests.
 *
 * Covers validateAllPending (cross-tenant dry-run compliance preview) and
 * exportVatReturnSummaries (CSV aggregator). Both work against seeded
 * invoice data: the setup inserts two firms, each with its own client
 * tenant and some invoices, so the tests also catch cross-firm bleed.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { DB } from '../src/db/db.module';
import { BatchOperationsService } from '../src/modules/firms/batch-operations.service';
import {
  COMPLIANCE_VALIDATOR,
  NoopComplianceValidator,
  type ComplianceValidator,
} from '../src/modules/invoices/compliance.port';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

/**
 * Stub validator that fails specific invoice IDs. Keeps the test
 * independent of @fawtara/compliance's rule set -- we only care that
 * BatchOperationsService correctly routes each invoice through the
 * validator and aggregates the pass/fail counts.
 */
class StubComplianceValidator implements ComplianceValidator {
  constructor(private readonly failIds: Set<string>) {}
  async validate(input: unknown) {
    const inv = (input as { invoice: { id: string; number: string } }).invoice;
    if (this.failIds.has(inv.id)) {
      return { ok: false, errors: [`stub-fail:${inv.number}`], rulePackVersion: 'stub-1' };
    }
    return { ok: true, rulePackVersion: 'stub-1' };
  }
}

describe('BatchOperationsService (W2-C)', () => {
  const firmA = randomUUID();
  const firmB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const tA1 = randomUUID();
  const tA2 = randomUUID();
  const tB1 = randomUUID();
  const partyA1 = randomUUID();
  const partyA2 = randomUUID();
  const partyB1 = randomUUID();
  const invA1Draft1 = randomUUID();
  const invA1Draft2 = randomUUID();
  const invA2Draft1 = randomUUID();
  const invA1Validated = randomUUID();
  const invB1Draft = randomUUID();
  const invB1Validated = randomUUID();

  let admin: Pool;
  let appPool: Pool;
  let svc: BatchOperationsService;
  let noopSvc: BatchOperationsService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES
         ($1,$2,$3),($4,$5,$6)`,
      [ownerA, `sub-${ownerA}`, `oA@test`, ownerB, `sub-${ownerB}`, `oB@test`],
    );
    await admin.query(
      `INSERT INTO tenants (id, name, vatin) VALUES
         ($1,'Batch-A1','OMVATA1'),
         ($2,'Batch-A2','OMVATA2'),
         ($3,'Batch-B1','OMVATB1')`,
      [tA1, tA2, tB1],
    );
    await admin.query(
      `INSERT INTO firms (id, name) VALUES ($1,'Batch Firm A'),($2,'Batch Firm B')`,
      [firmA, firmB],
    );
    await admin.query(
      `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [firmA, ownerA, firmB, ownerB],
    );
    await admin.query(
      `INSERT INTO firm_client_tenants (firm_id, tenant_id, access_level, engagement_type) VALUES
         ($1,$2,'full','ongoing'),($1,$3,'full','ongoing'),($4,$5,'full','ongoing')`,
      [firmA, tA1, tA2, firmB, tB1],
    );
    await admin.query(
      `INSERT INTO parties (id, tenant_id, kind, name) VALUES
         ($1,$2,'customer','A1-party'),
         ($3,$4,'customer','A2-party'),
         ($5,$6,'customer','B1-party')`,
      [partyA1, tA1, partyA2, tA2, partyB1, tB1],
    );
    // Seed invoices:
    //  - tA1: 2 DRAFT + 1 VALIDATED (within period)
    //  - tA2: 1 DRAFT (no validated)
    //  - tB1: 1 DRAFT + 1 VALIDATED
    await admin.query(
      `INSERT INTO invoices
         (id, tenant_id, number, issue_date, supplier_party_id, buyer_party_id, status,
          subtotal, vat_total, grand_total)
       VALUES
         ($1,$2,'A1-D1','2026-03-05',$3,$3,'DRAFT','100.000','5.000','105.000'),
         ($4,$2,'A1-D2','2026-03-10',$3,$3,'DRAFT','200.000','10.000','210.000'),
         ($5,$2,'A1-V1','2026-03-15',$3,$3,'VALIDATED','300.000','15.000','315.000'),
         ($6,$7,'A2-D1','2026-03-01',$8,$8,'DRAFT','50.000','2.500','52.500'),
         ($9,$10,'B1-D1','2026-03-02',$11,$11,'DRAFT','400.000','20.000','420.000'),
         ($12,$10,'B1-V1','2026-03-20',$11,$11,'VALIDATED','500.000','25.000','525.000')`,
      [
        invA1Draft1, tA1, partyA1,
        invA1Draft2,
        invA1Validated,
        invA2Draft1, tA2, partyA2,
        invB1Draft, tB1, partyB1,
        invB1Validated,
      ],
    );
    // Lines so the compliance pipeline has something to compute totals from
    // (even for the stub validator; a few tests use the noop validator).
    await admin.query(
      `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, vat_category, vat_rate, line_net)
       VALUES
         ($1,$2,1,'A1-D1 L1','1.000','100.000','S','5.00','100.000'),
         ($1,$3,1,'A1-D2 L1','2.000','100.000','S','5.00','200.000'),
         ($4,$5,1,'A2-D1 L1','1.000','50.000','S','5.00','50.000'),
         ($6,$7,1,'B1-D1 L1','4.000','100.000','S','5.00','400.000')`,
      [tA1, invA1Draft1, invA1Draft2, tA2, invA2Draft1, tB1, invB1Draft],
    );

    appPool = new Pool({ connectionString: APP_URL });
    const appDb = drizzle(appPool, { schema });

    const moduleRef = await Test.createTestingModule({
      providers: [
        BatchOperationsService,
        { provide: DB, useValue: appDb },
        {
          provide: COMPLIANCE_VALIDATOR,
          useValue: new StubComplianceValidator(new Set([invA1Draft2])),
        },
      ],
    }).compile();
    svc = moduleRef.get(BatchOperationsService);

    // Second instance using the Noop validator -- exercises the
    // "everything is valid" code path.
    const noopModule = await Test.createTestingModule({
      providers: [
        BatchOperationsService,
        { provide: DB, useValue: appDb },
        { provide: COMPLIANCE_VALIDATOR, useClass: NoopComplianceValidator },
      ],
    }).compile();
    noopSvc = noopModule.get(BatchOperationsService);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM invoice_lines WHERE tenant_id IN ($1,$2,$3)`, [tA1, tA2, tB1]);
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2,$3)`, [tA1, tA2, tB1]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2,$3)`, [tA1, tA2, tB1]);
    await admin.query(`DELETE FROM firms WHERE id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3)`, [tA1, tA2, tB1]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerA, ownerB]);
    await appPool.end();
    await admin.end();
  });

  describe('validateAllPending', () => {
    it('aggregates per-tenant pass/fail counts across all firm clients', async () => {
      const r = await svc.validateAllPending(firmA);
      expect(r.summary.tenantsScanned).toBe(2);
      expect(r.summary.totalDraft).toBe(3); // 2 in A1 + 1 in A2
      expect(r.summary.totalFailed).toBe(1); // invA1Draft2 fails via stub
      expect(r.summary.totalPassed).toBe(2);
      const a1 = r.perTenant.find((p) => p.tenantName === 'Batch-A1');
      expect(a1?.totalDraft).toBe(2);
      expect(a1?.failed).toBe(1);
      expect(a1?.passed).toBe(1);
      expect(a1?.failures[0].number).toBe('A1-D2');
      const a2 = r.perTenant.find((p) => p.tenantName === 'Batch-A2');
      expect(a2?.totalDraft).toBe(1);
      expect(a2?.failed).toBe(0);
    });

    it('ignores non-DRAFT invoices (no VALIDATED rows show up in counts)', async () => {
      const r = await svc.validateAllPending(firmA);
      // tA1 has 1 VALIDATED invoice; totalDraft should still be 2.
      const a1 = r.perTenant.find((p) => p.tenantName === 'Batch-A1');
      expect(a1?.totalDraft).toBe(2);
    });

    it('is isolated to one firm -- firm A scan never sees firm B DRAFTs', async () => {
      const rA = await svc.validateAllPending(firmA);
      const rB = await svc.validateAllPending(firmB);
      const aIds = rA.perTenant.flatMap((p) => p.failures.map((f) => f.invoiceId));
      const bIds = rB.perTenant.flatMap((p) => p.failures.map((f) => f.invoiceId));
      // The intersection should be empty.
      for (const id of aIds) expect(bIds).not.toContain(id);
      // Firm B sees its own client tenant only.
      expect(rB.summary.tenantsScanned).toBe(1);
      expect(rB.perTenant[0].tenantName).toBe('Batch-B1');
    });

    it('returns an empty result shape for a firm with no client tenants', async () => {
      // A fresh firm with no clients.
      const emptyFirm = randomUUID();
      await admin.query(`INSERT INTO firms (id, name) VALUES ($1,'Batch Firm Empty')`, [emptyFirm]);
      await admin.query(
        `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner')`,
        [emptyFirm, ownerA],
      );
      try {
        const r = await svc.validateAllPending(emptyFirm);
        expect(r.summary.tenantsScanned).toBe(0);
        expect(r.summary.totalDraft).toBe(0);
        expect(r.perTenant).toEqual([]);
      } finally {
        await admin.query(`DELETE FROM firms WHERE id = $1`, [emptyFirm]);
      }
    });

    it('with the noop validator reports every DRAFT as passing', async () => {
      const r = await noopSvc.validateAllPending(firmA);
      expect(r.summary.totalFailed).toBe(0);
      expect(r.summary.totalPassed).toBe(r.summary.totalDraft);
    });
  });

  describe('exportVatReturnSummaries', () => {
    it('produces one row per active client tenant with correct totals for the period', async () => {
      const rows = await svc.exportVatReturnSummaries(firmA, '2026-03-01', '2026-03-31');
      expect(rows).toHaveLength(2);
      const a1 = rows.find((r) => r.tenantName === 'Batch-A1');
      expect(a1).toBeDefined();
      // tA1 has one VALIDATED invoice in the window (A1-V1) counted.
      expect(a1?.invoiceCount).toBe(1);
      expect(Number(a1?.totalVatOmr)).toBeCloseTo(15, 3);
      expect(Number(a1?.totalTaxableOmr)).toBeCloseTo(300, 3);
      expect(Number(a1?.netOmr)).toBeCloseTo(315, 3);
      // tA2 has NO VALIDATED invoices in the window -- zero row.
      const a2 = rows.find((r) => r.tenantName === 'Batch-A2');
      expect(a2?.invoiceCount).toBe(0);
      expect(Number(a2?.totalVatOmr)).toBe(0);
    });

    it('is scoped to the firm -- firm B export excludes firm A invoices', async () => {
      const rows = await svc.exportVatReturnSummaries(firmB, '2026-03-01', '2026-03-31');
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantName).toBe('Batch-B1');
      expect(rows[0].invoiceCount).toBe(1);
      expect(Number(rows[0].totalVatOmr)).toBeCloseTo(25, 3);
    });

    it('respects the issue_date window', async () => {
      // Window outside anything in the fixture.
      const rows = await svc.exportVatReturnSummaries(firmA, '2026-01-01', '2026-01-31');
      for (const r of rows) {
        expect(r.invoiceCount).toBe(0);
        expect(Number(r.totalVatOmr)).toBe(0);
      }
    });
  });

  describe('renderVatReturnCsv (pure)', () => {
    it('produces an RFC-4180 header + one row per entry', () => {
      const csv = BatchOperationsService.renderVatReturnCsv([
        {
          tenantId: 't1',
          tenantName: 'Acme',
          vatin: 'OM1',
          invoiceCount: 3,
          totalTaxableOmr: '100.000',
          totalVatOmr: '5.000',
          netOmr: '105.000',
        },
      ]);
      expect(csv.split('\n')[0]).toBe(
        'tenantId,tenantName,vatin,invoiceCount,totalTaxableOmr,totalVatOmr,netOmr',
      );
      expect(csv).toContain('t1,Acme,OM1,3,100.000,5.000,105.000');
    });

    it('escapes commas and quotes inside tenant names', () => {
      const csv = BatchOperationsService.renderVatReturnCsv([
        {
          tenantId: 't1',
          tenantName: 'Acme, "the one"',
          vatin: null,
          invoiceCount: 0,
          totalTaxableOmr: '0',
          totalVatOmr: '0',
          netOmr: '0',
        },
      ]);
      expect(csv).toContain('"Acme, ""the one"""');
      // null vatin becomes an empty field (not the string "null").
      expect(csv).not.toMatch(/,null,/);
    });

    it('terminates with a trailing newline', () => {
      const csv = BatchOperationsService.renderVatReturnCsv([]);
      expect(csv.endsWith('\n')).toBe(true);
    });
  });
});
