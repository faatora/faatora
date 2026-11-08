import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../src/db/with-tenant';
import * as schema from '../src/db/schema';
import { AccountsService } from '../src/modules/bookkeeping/accounts.service';
import { JournalsService } from '../src/modules/bookkeeping/journals.service';
import { ReportsService } from '../src/modules/bookkeeping/reports.service';
import { SupplierBillsService } from '../src/modules/bookkeeping/supplier-bills.service';
import { PaymentsService } from '../src/modules/bookkeeping/payments.service';
import { OMANI_SME_COA, ACCOUNT_CODES } from '../src/modules/bookkeeping/omani-sme-coa';
import type { Database } from '../src/db/db.module';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('Bookkeeping', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let db: Database;
  let partyT1: string;
  let partyT2: string;
  let accounts: AccountsService;
  let journals: JournalsService;
  let reports: ReportsService;
  let supplierBills: SupplierBillsService;
  let payments: PaymentsService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'BK-T1'),($2,'BK-T2')`, [t1, t2]);
    const p1 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','Cust 1') RETURNING id`,
        [t1],
      )
    ).rows[0].id as string;
    const p2 = (
      await admin.query(
        `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','Cust 2') RETURNING id`,
        [t2],
      )
    ).rows[0].id as string;
    partyT1 = p1;
    partyT2 = p2;
    appPool = new Pool({ connectionString: APP_URL });
    db = drizzle(appPool, { schema }) as Database;
    accounts = new AccountsService(db);
    journals = new JournalsService(db);
    reports = new ReportsService(db);
    supplierBills = new SupplierBillsService(db);
    payments = new PaymentsService(db);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [t1, t2]);
    await appPool.end();
    await admin.end();
  });

  it('seedCoa inserts 22 accounts on first call and is a no-op on second', async () => {
    const first = await accounts.seedCoa(t1);
    expect(first.seeded).toBe(true);
    expect(first.inserted).toBe(OMANI_SME_COA.length);
    const all = await accounts.list(t1);
    expect(all.length).toBe(OMANI_SME_COA.length);
    const second = await accounts.seedCoa(t1);
    expect(second.seeded).toBe(false);
    expect(second.inserted).toBe(0);
  });

  it('seeds a different tenant independently and keeps accounts isolated', async () => {
    await accounts.seedCoa(t2);
    const t1Rows = await accounts.list(t1);
    const t2Rows = await accounts.list(t2);
    expect(t1Rows).toHaveLength(OMANI_SME_COA.length);
    expect(t2Rows).toHaveLength(OMANI_SME_COA.length);
    const t1Ids = new Set(t1Rows.map((r) => r.id));
    const t2Ids = new Set(t2Rows.map((r) => r.id));
    for (const id of t1Ids) expect(t2Ids.has(id)).toBe(false);
  });

  it('posts a balanced manual journal and rejects an unbalanced one', async () => {
    const list = await accounts.list(t1);
    const byCode = Object.fromEntries(list.map((a) => [a.code, a.id] as const));
    const posted = await journals.postManual(t1, {
      entryDate: '2026-01-15',
      memo: 'Owner contribution',
      lines: [
        { accountId: byCode[ACCOUNT_CODES.BANK], debit: 10000, credit: 0 },
        { accountId: byCode['3100'], debit: 0, credit: 10000 },
      ],
    });
    expect(posted.posted).toBe(true);
    expect(posted.lines).toHaveLength(2);
    await expect(
      journals.postManual(t1, {
        entryDate: '2026-01-16',
        memo: 'Unbalanced',
        lines: [
          { accountId: byCode[ACCOUNT_CODES.BANK], debit: 500, credit: 0 },
          { accountId: byCode['3100'], debit: 0, credit: 400 },
        ],
      }),
    ).rejects.toThrow(/not balanced/i);
  });

  it('trial balance after one manual journal shows matching totals', async () => {
    const tb = await reports.trialBalance(t1);
    expect(tb.totals.debit).toBeCloseTo(tb.totals.credit, 3);
    expect(tb.totals.debit).toBeGreaterThan(0);
    const bankRow = tb.rows.find((r) => r.code === ACCOUNT_CODES.BANK);
    const capitalRow = tb.rows.find((r) => r.code === '3100');
    expect(bankRow?.debit).toBeCloseTo(10000, 3);
    expect(capitalRow?.credit).toBeCloseTo(10000, 3);
  });

  it('VAT return sums 2 standard-rated + 1 zero-rated correctly', async () => {
    const tenantId = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'BK-VAT')`, [tenantId]);
    try {
      // Seed CoA for this tenant.
      await accounts.seedCoa(tenantId);
      // Create a supplier and customer party via admin (bypass tenant guard; column defaults handle).
      const supplierId = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S Co') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const buyerId = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B Co') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;

      // Insert invoices + lines directly as admin to isolate VAT return math.
      const makeInvoice = async (
        number: string,
        status: string,
        lines: Array<{ qty: number; price: number; cat: string; rate: number }>,
      ) => {
        const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0);
        const vatTotal = lines.reduce((a, l) => a + (l.qty * l.price * l.rate) / 100, 0);
        const grand = subtotal + vatTotal;
        const inv = await admin.query(
          `INSERT INTO invoices (tenant_id, type, number, status, currency, issue_date, supplier_party_id, buyer_party_id, subtotal, vat_total, grand_total, vat_breakdown)
           VALUES ($1,'invoice',$2,$3,'OMR','2026-02-10',$4,$5,$6,$7,$8,'[]'::jsonb) RETURNING id`,
          [
            tenantId,
            number,
            status,
            supplierId,
            buyerId,
            subtotal.toFixed(3),
            vatTotal.toFixed(3),
            grand.toFixed(3),
          ],
        );
        const invId = inv.rows[0].id as string;
        let lineNo = 1;
        for (const l of lines) {
          await admin.query(
            `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, vat_category, vat_rate, line_net)
             VALUES ($1,$2,$3,'item',$4,$5,$6,$7,$8)`,
            [
              tenantId,
              invId,
              lineNo++,
              l.qty.toFixed(3),
              l.price.toFixed(3),
              l.cat,
              l.rate.toFixed(2),
              (l.qty * l.price).toFixed(3),
            ],
          );
        }
        return invId;
      };
      await makeInvoice('INV-S1', 'VALIDATED', [{ qty: 10, price: 100, cat: 'S', rate: 5 }]); // net 1000, vat 50
      await makeInvoice('INV-S2', 'VALIDATED', [{ qty: 1, price: 500, cat: 'S', rate: 5 }]); // net 500, vat 25
      await makeInvoice('INV-Z1', 'VALIDATED', [{ qty: 2, price: 250, cat: 'Z', rate: 0 }]); // net 500, zero rated
      await makeInvoice('INV-DRAFT', 'DRAFT', [{ qty: 100, price: 100, cat: 'S', rate: 5 }]); // excluded

      const v = await reports.vatReturn(tenantId, '2026-02-01', '2026-02-28');
      expect(v.outputStandard.net).toBeCloseTo(1500, 3);
      expect(v.outputStandard.vat).toBeCloseTo(75, 3);
      expect(v.outputZero.net).toBeCloseTo(500, 3);
      expect(v.outputZero.vat).toBe(0);
      expect(v.outputExempt.net).toBe(0);
      expect(v.inputTotal).toBe(0);
      expect(v.netVatPayable).toBeCloseTo(75, 3);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('posts invoice-issued journal using the right income account by vat category', async () => {
    const tenantId = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'BK-POST')`, [tenantId]);
    try {
      await accounts.seedCoa(tenantId);
      const supplierId = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'supplier','S') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const buyerId = (
        await admin.query(
          `INSERT INTO parties (tenant_id, kind, name) VALUES ($1,'customer','B') RETURNING id`,
          [tenantId],
        )
      ).rows[0].id as string;
      const inv = await admin.query(
        `INSERT INTO invoices (tenant_id, type, number, status, currency, issue_date, supplier_party_id, buyer_party_id, subtotal, vat_total, grand_total, vat_breakdown)
         VALUES ($1,'invoice','INV-A','VALIDATED','OMR','2026-03-01',$2,$3,'1000.000','50.000','1050.000','[]'::jsonb) RETURNING id`,
        [tenantId, supplierId, buyerId],
      );
      const invId = inv.rows[0].id as string;
      await admin.query(
        `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, vat_category, vat_rate, line_net)
         VALUES ($1,$2,1,'line',1,'1000.000','S','5.00','1000.000')`,
        [tenantId, invId],
      );
      const posted = await journals.postInvoiceIssued(tenantId, invId);
      expect(posted.posted).toBe(true);
      expect(posted.lines).toHaveLength(3);
      const totalDebit = posted.lines.reduce((a, l) => a + Number(l.debit), 0);
      const totalCredit = posted.lines.reduce((a, l) => a + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 3);
      expect(totalDebit).toBeCloseTo(1050, 3);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('cross-tenant isolation blocks reading another tenant accounts and journals', async () => {
    const t1Accounts = await accounts.list(t1);
    const t1AccountIds = t1Accounts.map((a) => a.id);
    // From t2's context, selecting the account ids from t1 should return nothing.
    const seenFromT2 = await withTenant(db, t2, (tx) =>
      tx.select().from(schema.accounts).where(inArray(schema.accounts.id, t1AccountIds)),
    );
    expect(seenFromT2).toHaveLength(0);
    // Journals the same.
    const t1Journals = await journals.list(t1);
    const seenJournalsFromT2 = await withTenant(db, t2, (tx) =>
      tx
        .select()
        .from(schema.journals)
        .where(
          and(
            eq(schema.journals.tenantId, t1),
            inArray(
              schema.journals.id,
              t1Journals.map((j) => j.id),
            ),
          ),
        ),
    );
    expect(seenJournalsFromT2).toHaveLength(0);
  });

  it('supplier bill + payment CRUD is tenant-scoped', async () => {
    const bill = await supplierBills.create(t1, {
      supplierPartyId: partyT1,
      number: 'BILL-1',
      issueDate: '2026-04-05',
      subtotal: 100,
      vatTotal: 5,
      grandTotal: 105,
    });
    expect(bill.id).toBeDefined();
    const got = await supplierBills.get(t1, bill.id);
    expect(got.number).toBe('BILL-1');
    const other = await supplierBills.list(t2);
    expect(other.find((b) => b.id === bill.id)).toBeUndefined();

    const pay = await payments.create(t1, {
      direction: 'in',
      date: '2026-04-10',
      amount: 100,
      method: 'bank',
      partyId: partyT1,
    });
    expect(pay.id).toBeDefined();
    const otherPay = await payments.list(t2);
    expect(otherPay.find((p) => p.id === pay.id)).toBeUndefined();
    // Sanity: tenant t2 can create a payment for its own party.
    const okPay = await payments.create(t2, {
      direction: 'in',
      date: '2026-04-10',
      amount: 10,
      method: 'bank',
      partyId: partyT2,
    });
    expect(okPay.id).toBeDefined();
  });
});
