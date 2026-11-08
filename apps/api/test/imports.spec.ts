import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { withTenant } from '../src/db/with-tenant';
import { ImportsService } from '../src/modules/imports/imports.service';
import { parseCsv } from '../src/modules/imports/parsers/csv.parser';
import { parseExcel } from '../src/modules/imports/parsers/excel.parser';
import { parseTallyXml } from '../src/modules/imports/parsers/tally.parser';
import { invoices, invoiceLines, parties } from '../src/db/schema/invoicing';
import { importJobs, importErrors } from '../src/db/schema/imports';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

const CSV_HEADER =
  'number,issue_date,supplier_vatin,supplier_name,buyer_vatin,buyer_name,line_description,line_quantity,line_unit_price,line_vat_rate,line_vat_category';

describe('Imports', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  const u1 = randomUUID();
  const u2 = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let svc: ImportsService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'T1'),($2,'T2')`, [t1, t2]);
    await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`, [
      u1,
      `sub-${u1}`,
      'imp-u1@x',
      u2,
      `sub-${u2}`,
      'imp-u2@x',
    ]);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [t1, u1, t2, u2],
    );
    appPool = new Pool({ connectionString: APP_URL });
    appDb = drizzle(appPool, { schema });
    svc = new ImportsService(appDb);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [t1, t2]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [u1, u2]);
    await appPool.end();
    await admin.end();
  });

  describe('CSV parser', () => {
    it('parses a valid header + row', async () => {
      const csv = [
        CSV_HEADER,
        'INV-1,2026-01-15,OM1234567,Supplier A,OM7654321,Buyer A,Widget,2,10.5,5,S',
      ].join('\n');
      const r = await parseCsv(Buffer.from(csv));
      expect(r.errors).toEqual([]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].number).toBe('INV-1');
      expect(r.rows[0].lineQuantity).toBe(2);
      expect(r.rows[0].lineUnitPrice).toBe(10.5);
    });

    it('reports missing header column', async () => {
      const csv = 'number,issue_date\nINV-1,2026-01-15';
      const r = await parseCsv(Buffer.from(csv));
      expect(r.rows).toEqual([]);
      expect(r.errors[0].message).toMatch(/Missing required header/);
    });

    it('reports row-level error for bad quantity', async () => {
      const csv = [CSV_HEADER, 'INV-1,2026-01-15,,Sup,,Buy,Widget,notanumber,10,5,S'].join('\n');
      const r = await parseCsv(Buffer.from(csv));
      expect(r.rows).toEqual([]);
      expect(r.errors[0].columnName).toBe('line_quantity');
      expect(r.errors[0].message).toMatch(/quantity/);
    });
  });

  describe('startImport (CSV)', () => {
    it('imports 3 invoices with 6 lines total (grouping multi-line invoices)', async () => {
      const csv = [
        CSV_HEADER,
        'IMPA-1,2026-01-15,OMSUP1,Sup One,OMBUY1,Buy One,Line A,2,10,5,S',
        'IMPA-1,2026-01-15,OMSUP1,Sup One,OMBUY1,Buy One,Line B,1,25,5,S',
        'IMPA-2,2026-01-16,OMSUP1,Sup One,OMBUY2,Buy Two,Line C,3,8.5,5,S',
        'IMPA-3,2026-01-17,OMSUP1,Sup One,OMBUY3,Buy Three,Line D,1,100,5,S',
        'IMPA-3,2026-01-17,OMSUP1,Sup One,OMBUY3,Buy Three,Line E,2,50,5,S',
        'IMPA-3,2026-01-17,OMSUP1,Sup One,OMBUY3,Buy Three,Line F,4,2.5,5,S',
      ].join('\n');
      const summary = await svc.startImport(t1, u1, 'csv', 'batch.csv', Buffer.from(csv));
      expect(summary.importedRows).toBe(3);
      expect(summary.errorRows).toBe(0);
      expect(summary.status).toBe('completed');
      const invs = await withTenant(appDb, t1, (tx) =>
        tx.select().from(invoices).where(eq(invoices.tenantId, t1)),
      );
      const insertedNums = invs.map((i) => i.number).sort();
      expect(insertedNums).toEqual(expect.arrayContaining(['IMPA-1', 'IMPA-2', 'IMPA-3']));
      const impa1 = invs.find((i) => i.number === 'IMPA-1');
      const impa1Lines = await withTenant(appDb, t1, (tx) =>
        tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, impa1!.id)),
      );
      expect(impa1Lines).toHaveLength(2);
      const impa3Lines = await withTenant(appDb, t1, (tx) =>
        tx
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, invs.find((i) => i.number === 'IMPA-3')!.id)),
      );
      expect(impa3Lines).toHaveLength(3);
    });

    it('row-level error reporting: malformed quantity on row 4 yields error with row_no=4', async () => {
      const csv = [
        CSV_HEADER,
        'IMPB-1,2026-02-01,OMSUP2,Sup B,OMBUYB1,Buy B1,Thing 1,1,10,5,S', // row 2
        'IMPB-2,2026-02-02,OMSUP2,Sup B,OMBUYB2,Buy B2,Thing 2,2,20,5,S', // row 3
        'IMPB-3,2026-02-03,OMSUP2,Sup B,OMBUYB3,Buy B3,BadQty,notnum,30,5,S', // row 4 -- bad quantity
      ].join('\n');
      const summary = await svc.startImport(t1, u1, 'csv', 'malformed.csv', Buffer.from(csv));
      expect(summary.importedRows).toBe(2);
      expect(summary.errorRows).toBe(1);
      const detail = await svc.getJobWithErrors(t1, summary.jobId);
      expect(detail.errors).toHaveLength(1);
      expect(detail.errors[0].rowNo).toBe(4);
      expect(detail.errors[0].message.toLowerCase()).toContain('quantity');
      expect(detail.errors[0].columnName).toBe('line_quantity');
    });

    it('party lookup reuses existing by VATIN', async () => {
      // Insert one party up front, then import a row with the same vatin — should reuse.
      const existingVat = 'OMREUSE1';
      const [existing] = await withTenant(appDb, t1, (tx) =>
        tx
          .insert(parties)
          .values({
            tenantId: t1,
            kind: 'customer',
            name: 'Original Name',
            vatin: existingVat,
            country: 'OM',
          })
          .returning(),
      );
      const csv = [
        CSV_HEADER,
        `IMPC-1,2026-03-01,OMSUP3,Sup C,${existingVat},Different Name,Line,1,10,5,S`,
      ].join('\n');
      const summary = await svc.startImport(t1, u1, 'csv', 'reuse.csv', Buffer.from(csv));
      expect(summary.importedRows).toBe(1);
      const [inv] = await withTenant(appDb, t1, (tx) =>
        tx.select().from(invoices).where(eq(invoices.number, 'IMPC-1')).limit(1),
      );
      expect(inv.buyerPartyId).toBe(existing.id);
    });
  });

  describe('Excel parser', () => {
    async function buildWorkbook(data: Array<Array<string | number>>): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      data.forEach((row) => ws.addRow(row));
      const out = await wb.xlsx.writeBuffer();
      return Buffer.from(out as ArrayBuffer);
    }

    it('parses a valid xlsx', async () => {
      const buf = await buildWorkbook([
        [
          'number',
          'issue_date',
          'supplier_vatin',
          'supplier_name',
          'buyer_vatin',
          'buyer_name',
          'line_description',
          'line_quantity',
          'line_unit_price',
          'line_vat_rate',
          'line_vat_category',
        ],
        ['XLS-1', '2026-04-01', 'OMX1', 'SupX', 'OMY1', 'BuyX', 'Widget', 3, 15.5, 5, 'S'],
      ]);
      const r = await parseExcel(buf);
      expect(r.errors).toEqual([]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].number).toBe('XLS-1');
      expect(r.rows[0].lineQuantity).toBe(3);
    });

    it('reports row-level error for text in quantity cell', async () => {
      const buf = await buildWorkbook([
        [
          'number',
          'issue_date',
          'supplier_vatin',
          'supplier_name',
          'buyer_vatin',
          'buyer_name',
          'line_description',
          'line_quantity',
          'line_unit_price',
          'line_vat_rate',
          'line_vat_category',
        ],
        ['XLS-BAD', '2026-04-01', '', 'SupX', '', 'BuyX', 'Widget', 'oops', 10, 5, 'S'],
      ]);
      const r = await parseExcel(buf);
      expect(r.rows).toEqual([]);
      expect(r.errors[0].columnName).toBe('line_quantity');
    });
  });

  describe('Tally parser', () => {
    it('imports 1 invoice correctly', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <BODY>
    <IMPORTDATA>
      <REQUESTDATA>
        <TALLYMESSAGE>
          <VOUCHER VCHTYPE="Sales">
            <DATE>20260501</DATE>
            <VOUCHERNUMBER>TLY-001</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Oman Buyer LLC</PARTYLEDGERNAME>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>Steel Rod</STOCKITEMNAME>
              <ACTUALQTY>10 Nos</ACTUALQTY>
              <RATE>25.000/Nos</RATE>
            </ALLINVENTORYENTRIES.LIST>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>Cement Bag</STOCKITEMNAME>
              <ACTUALQTY>5 Nos</ACTUALQTY>
              <RATE>12.500/Nos</RATE>
            </ALLINVENTORYENTRIES.LIST>
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>VAT @ 5%</LEDGERNAME>
            </LEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
      const parsed = await parseTallyXml(Buffer.from(xml));
      expect(parsed.errors).toEqual([]);
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].number).toBe('TLY-001');
      expect(parsed.rows[0].issueDate).toBe('2026-05-01');
      expect(parsed.rows[0].lineQuantity).toBe(10);
      expect(parsed.rows[0].lineUnitPrice).toBe(25);
      expect(parsed.rows[0].lineVatRate).toBe(5);

      const summary = await svc.startImport(t1, u1, 'tally_xml', 'tally.xml', Buffer.from(xml));
      expect(summary.importedRows).toBe(1);
      expect(summary.errorRows).toBe(0);
      const [inv] = await withTenant(appDb, t1, (tx) =>
        tx.select().from(invoices).where(eq(invoices.number, 'TLY-001')).limit(1),
      );
      expect(inv).toBeDefined();
      const lines = await withTenant(appDb, t1, (tx) =>
        tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)),
      );
      expect(lines).toHaveLength(2);
    });

    it('reports error when VOUCHERNUMBER missing', async () => {
      const xml = `<?xml version="1.0"?>
<ENVELOPE><BODY><VOUCHER>
  <DATE>20260601</DATE>
  <PARTYLEDGERNAME>Someone</PARTYLEDGERNAME>
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>Item</STOCKITEMNAME>
    <ACTUALQTY>1</ACTUALQTY>
    <RATE>10</RATE>
  </ALLINVENTORYENTRIES.LIST>
</VOUCHER></BODY></ENVELOPE>`;
      const r = await parseTallyXml(Buffer.from(xml));
      expect(r.rows).toEqual([]);
      expect(r.errors[0].columnName).toBe('VOUCHERNUMBER');
    });

    it('reports error when quantity NaN', async () => {
      const xml = `<?xml version="1.0"?>
<ENVELOPE><BODY><VOUCHER>
  <VOUCHERNUMBER>TLY-BAD</VOUCHERNUMBER>
  <DATE>20260601</DATE>
  <PARTYLEDGERNAME>Someone</PARTYLEDGERNAME>
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>Item</STOCKITEMNAME>
    <ACTUALQTY>notanumber</ACTUALQTY>
    <RATE>10</RATE>
  </ALLINVENTORYENTRIES.LIST>
</VOUCHER></BODY></ENVELOPE>`;
      const r = await parseTallyXml(Buffer.from(xml));
      expect(r.rows).toEqual([]);
      expect(r.errors.some((e) => e.columnName === 'ACTUALQTY')).toBe(true);
    });
  });

  describe('cross-tenant isolation', () => {
    it('tenant 2 cannot see tenant 1 jobs or errors', async () => {
      const csv = [CSV_HEADER, 'ISO-1,2026-07-01,,SupIso,,BuyIso,Widget,1,10,5,S'].join('\n');
      const t1Summary = await svc.startImport(t1, u1, 'csv', 'iso.csv', Buffer.from(csv));
      const jobsT2 = await svc.listJobs(t2);
      expect(jobsT2.find((j) => j.id === t1Summary.jobId)).toBeUndefined();
      await expect(svc.getJobWithErrors(t2, t1Summary.jobId)).rejects.toThrow();

      // Tenant 1 cannot see errors from tenant 2 either.
      const badCsv = [CSV_HEADER, 'ISO-2,2026-07-01,,SupIso,,BuyIso,Widget,bad,10,5,S'].join('\n');
      const t2Summary = await svc.startImport(t2, u2, 'csv', 'iso2.csv', Buffer.from(badCsv));
      await expect(svc.getJobWithErrors(t1, t2Summary.jobId)).rejects.toThrow();

      // Also assert the RLS filter on raw table reads: tenant 2 should not see tenant 1's error row.
      const t2VisibleErrors = await withTenant(appDb, t2, (tx) =>
        tx.select().from(importErrors).where(eq(importErrors.jobId, t1Summary.jobId)),
      );
      expect(t2VisibleErrors).toEqual([]);
    });
  });

  describe('idempotency / duplicate numbers', () => {
    it('re-running same CSV creates a NEW job and generates error rows for duplicates', async () => {
      const csv = [CSV_HEADER, 'DUP-1,2026-08-01,,SupD,,BuyD,Widget,1,10,5,S'].join('\n');
      const first = await svc.startImport(t1, u1, 'csv', 'first.csv', Buffer.from(csv));
      expect(first.importedRows).toBe(1);
      expect(first.errorRows).toBe(0);

      const second = await svc.startImport(t1, u1, 'csv', 'second.csv', Buffer.from(csv));
      expect(second.jobId).not.toBe(first.jobId);
      expect(second.importedRows).toBe(0);
      expect(second.errorRows).toBe(1);
      expect(second.status).toBe('failed');

      const detail = await svc.getJobWithErrors(t1, second.jobId);
      expect(detail.errors).toHaveLength(1);
      expect(detail.errors[0].rawValue).toBe('DUP-1');

      // Confirm there is still only ONE DUP-1 invoice.
      const dupInvs = await withTenant(appDb, t1, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, t1), eq(invoices.number, 'DUP-1'))),
      );
      expect(dupInvs).toHaveLength(1);

      // Confirm both jobs exist (not deduped).
      const allJobs = await withTenant(appDb, t1, (tx) =>
        tx.select().from(importJobs).where(eq(importJobs.tenantId, t1)),
      );
      expect(allJobs.filter((j) => j.id === first.jobId || j.id === second.jobId)).toHaveLength(2);
    });
  });
});
