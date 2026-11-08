/**
 * EP5 Wave 2 (W2-D) — FirmImportsService + parsers + column mapping.
 *
 * Covers:
 *   - Each parser normalizes to the canonical row shape (Tally Day
 *     Book, Tally Sales Register, Tally XML, Zoho Books CSV)
 *   - Preview validation surfaces required-field, date-parse and
 *     VAT-math-mismatch errors with the row number and reason
 *   - Preview idempotency: re-uploading the same file after a commit
 *     flags every row as duplicate and the next commit writes nothing
 *   - Commit writes DRAFT invoices under withFirmTenant
 *   - Column mapping default + per-firm override round-trip
 *   - The `firm.import.committed` event is emitted with the batch metadata
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as schema from '../src/db/schema';
import { DB } from '../src/db/db.module';
import { withFirm } from '../src/db/with-firm';
import { withTenant } from '../src/db/with-tenant';
import { withFirmTenant } from '../src/db/with-firm-tenant';
import { invoices } from '../src/db/schema/invoicing';
import { importBatches, importColumnMappings } from '../src/db/schema/firm-imports';
import { ColumnMappingService } from '../src/modules/imports/column-mapping.service';
import { FirmImportsService } from '../src/modules/imports/firm-imports.service';
import { parseTallyCsv } from '../src/modules/imports/parsers/tally-csv.parser';
import { parseTallyXml } from '../src/modules/imports/parsers/tally-xml.parser';
import { parseZohoBooksCsv } from '../src/modules/imports/parsers/zoho-books-csv.parser';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

const TALLY_SALES_REGISTER_CSV = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-01-05,Sales,INV-1001,Alpha LLC,OM1100000011,100.000,5.000,105.000
2026-01-08,Sales,INV-1002,Beta Co,OM1100000022,200.000,10.000,210.000
`;

const TALLY_DAY_BOOK_CSV = `Date,Voucher Type,Voucher No.,Debit Ledger,Credit Ledger,Debit Amount,Credit Amount,Narration
15-01-2026,Sales,DB-1,Omega LLC,,105.000,0,Omega sale
15-01-2026,Sales,DB-1,,Sales Account,0,100.000,Omega sale
15-01-2026,Sales,DB-1,,VAT @ 5%,0,5.000,Omega sale
`;

const ZOHO_BOOKS_CSV = `Invoice Date,Invoice ID,Customer Name,Customer ID,Customer VATIN,Item Name,Quantity,Rate,Discount,Tax Name,Tax %,Total
2026-02-01,ZB-001,Gamma Trading,CUST-1,OM2200000033,Widget,2,50.000,0,VAT,5,105.000
2026-02-01,ZB-001,Gamma Trading,CUST-1,OM2200000033,Gadget,1,10.000,0,VAT,5,10.500
2026-02-02,ZB-002,Delta Supplies,CUST-2,OM2200000044,Service,1,80.000,0,VAT,5,84.000
`;

const TALLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <BODY>
    <IMPORTDATA><REQUESTDATA>
      <TALLYMESSAGE>
        <VOUCHER>
          <DATE>20260110</DATE>
          <VOUCHERNUMBER>XML-1</VOUCHERNUMBER>
          <PARTYLEDGERNAME>Epsilon LLC</PARTYLEDGERNAME>
          <PARTYVATIN>OM3300000055</PARTYVATIN>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>Epsilon LLC</LEDGERNAME>
            <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
            <AMOUNT>-105.000</AMOUNT>
          </LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>Sales Account</LEDGERNAME>
            <ISPARTYLEDGER>No</ISPARTYLEDGER>
            <AMOUNT>100.000</AMOUNT>
          </LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>VAT @ 5%</LEDGERNAME>
            <ISPARTYLEDGER>No</ISPARTYLEDGER>
            <AMOUNT>5.000</AMOUNT>
          </LEDGERENTRIES.LIST>
        </VOUCHER>
        <VOUCHER>
          <DATE>20260111</DATE>
          <VOUCHERNUMBER>XML-2</VOUCHERNUMBER>
          <PARTYLEDGERNAME>Zeta LLC</PARTYLEDGERNAME>
          <PARTYVATIN>OM3300000066</PARTYVATIN>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>Zeta LLC</LEDGERNAME>
            <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
            <AMOUNT>-210.000</AMOUNT>
          </LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>Sales Account</LEDGERNAME>
            <AMOUNT>200.000</AMOUNT>
          </LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST>
            <LEDGERNAME>VAT @ 5%</LEDGERNAME>
            <AMOUNT>10.000</AMOUNT>
          </LEDGERENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </REQUESTDATA></IMPORTDATA>
  </BODY>
</ENVELOPE>`;

describe('Firm Imports (W2-D)', () => {
  const firmA = randomUUID();
  const firmB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let mappings: ColumnMappingService;
  let svc: FirmImportsService;
  let events: EventEmitter2;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`,
      [ownerA, `sub-${ownerA}`, `ownerA-${ownerA}@test`, ownerB, `sub-${ownerB}`, `ownerB-${ownerB}@test`],
    );
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'W2D TA'),($2,'W2D TB')`, [
      tenantA,
      tenantB,
    ]);
    await admin.query(`INSERT INTO firms (id, name) VALUES ($1,'W2D Firm A'),($2,'W2D Firm B')`, [
      firmA,
      firmB,
    ]);
    await admin.query(
      `INSERT INTO firm_memberships (firm_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
      [firmA, ownerA, firmB, ownerB],
    );
    await admin.query(
      `INSERT INTO firm_client_tenants (firm_id, tenant_id, access_level, engagement_type)
         VALUES ($1,$2,'full','ongoing'),($3,$4,'full','ongoing')`,
      [firmA, tenantA, firmB, tenantB],
    );
    appPool = new Pool({ connectionString: APP_URL });
    appDb = drizzle(appPool, { schema });
    mappings = new ColumnMappingService(appDb);
    events = new EventEmitter2();
    svc = new FirmImportsService(appDb, mappings, events);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM import_batches WHERE firm_id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM import_column_mappings WHERE firm_id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM firms WHERE id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerA, ownerB]);
    await appPool.end();
    await admin.end();
  });

  afterEach(async () => {
    await admin.query(`DELETE FROM import_batches WHERE firm_id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM import_column_mappings WHERE firm_id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
  });

  describe('parsers', () => {
    it('parses a Tally Sales Register CSV into canonical raw rows', async () => {
      const r = await parseTallyCsv(Buffer.from(TALLY_SALES_REGISTER_CSV));
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(2);
      expect(r.rawRows[0].cells['Voucher No.']).toBe('INV-1001');
      expect(r.rawRows[0].cells['Total Amount']).toBe('105.000');
      expect(r.rawRows[1].cells['Party VATIN']).toBe('OM1100000022');
    });

    it('parses a Tally Day Book CSV by grouping on voucher', async () => {
      const r = await parseTallyCsv(Buffer.from(TALLY_DAY_BOOK_CSV));
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(1);
      const row = r.rawRows[0].cells;
      expect(row['Voucher No.']).toBe('DB-1');
      expect(row['Taxable Amount']).toBe('100.000');
      expect(row['VAT Amount']).toBe('5.000');
      expect(row['Total Amount']).toBe('105.000');
      expect(row['Party Ledger']).toBe('Omega LLC');
    });

    it('parses a Zoho Books CSV by grouping line items', async () => {
      const r = await parseZohoBooksCsv(Buffer.from(ZOHO_BOOKS_CSV));
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(2);
      const first = r.rawRows[0].cells;
      expect(first['Invoice ID']).toBe('ZB-001');
      expect(first['Customer Name']).toBe('Gamma Trading');
      expect(first['Taxable Amount']).toBe('110.000');
      expect(first['VAT Amount']).toBe('5.500');
      expect(first['Total']).toBe('115.500');
    });

    it('parses Tally XML into canonical raw rows', async () => {
      const r = await parseTallyXml(Buffer.from(TALLY_XML));
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(2);
      const first = r.rawRows[0].cells;
      expect(first['Voucher No.']).toBe('XML-1');
      expect(first['Date']).toBe('2026-01-10');
      expect(first['Party Ledger']).toBe('Epsilon LLC');
      expect(first['Total Amount']).toBe('105.000');
      expect(first['Taxable Amount']).toBe('100.000');
      expect(first['VAT Amount']).toBe('5.000');
    });

    it('returns structural error on unknown Tally CSV layout', async () => {
      const csv = 'foo,bar\n1,2\n';
      const r = await parseTallyCsv(Buffer.from(csv));
      expect(r.rawRows).toEqual([]);
      expect(r.errors[0].message).toMatch(/Unrecognized Tally CSV layout/);
    });

    it('returns structural error on malformed XML', async () => {
      const r = await parseTallyXml(Buffer.from('<<<not xml'));
      // fast-xml-parser may accept partial input; either way there
      // must be no vouchers detected.
      expect(r.rawRows).toEqual([]);
      expect(r.errors.length).toBeGreaterThan(0);
    });

    it('surfaces a Zoho Books missing-header error', async () => {
      const csv = 'Invoice Date,Invoice ID\n2026-01-01,X1\n';
      const r = await parseZohoBooksCsv(Buffer.from(csv));
      expect(r.rawRows).toEqual([]);
      expect(r.errors[0].message).toMatch(/Missing required Zoho Books column/);
    });

    it('parses the on-disk Tally Sales Register fixture', async () => {
      const buf = readFileSync(
        join(__dirname, 'fixtures/imports/tally-sales-register.csv'),
      );
      const r = await parseTallyCsv(buf);
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(3);
    });

    it('parses the on-disk Tally Day Book fixture (2 vouchers)', async () => {
      const buf = readFileSync(join(__dirname, 'fixtures/imports/tally-daybook.csv'));
      const r = await parseTallyCsv(buf);
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(2);
    });

    it('parses the on-disk Zoho Books fixture (3 invoices)', async () => {
      const buf = readFileSync(join(__dirname, 'fixtures/imports/zoho-books.csv'));
      const r = await parseZohoBooksCsv(buf);
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(3);
    });

    it('parses the on-disk Tally XML fixture (2 vouchers)', async () => {
      const buf = readFileSync(join(__dirname, 'fixtures/imports/tally-prime.xml'));
      const r = await parseTallyXml(buf);
      expect(r.errors).toEqual([]);
      expect(r.rawRows).toHaveLength(2);
    });
  });

  describe('column mapping', () => {
    it('returns the baked-in default when no firm override exists', async () => {
      const m = await mappings.getForFirm(firmA, 'tally_sales_register_csv');
      expect(m.invoiceNumber).toBe('Voucher No.');
      expect(m.totalAmount).toBe('Total Amount');
    });

    it('persists a firm override and returns it on subsequent reads', async () => {
      const override = {
        invoiceNumber: 'Voucher No.',
        invoiceDate: 'Date',
        buyerName: 'Party Ledger',
        buyerVatin: 'Party VATIN',
        taxableAmount: 'Taxable Amount',
        vatAmount: 'VAT Amount',
        totalAmount: 'Total Amount',
        description: 'Narration',
        supplierName: 'Party Ledger', // wacky override, just to prove round-trip
      };
      await mappings.saveForFirm(firmA, 'tally_sales_register_csv', override);
      const back = await mappings.getForFirm(firmA, 'tally_sales_register_csv');
      expect(back.supplierName).toBe('Party Ledger');
    });

    it('overrides are firm-isolated (firmB default persists after firmA saves)', async () => {
      await mappings.saveForFirm(firmA, 'zoho_books_csv', {
        invoiceNumber: 'CUSTOM-FIELD',
        invoiceDate: 'Invoice Date',
        buyerName: 'Customer Name',
        buyerVatin: 'Customer VATIN',
        taxableAmount: 'Taxable Amount',
        vatAmount: 'VAT Amount',
        totalAmount: 'Total',
      });
      const b = await mappings.getForFirm(firmB, 'zoho_books_csv');
      expect(b.invoiceNumber).toBe('Invoice ID');
    });
  });

  describe('preview validation', () => {
    it('reports VAT math mismatch with row number and figures', async () => {
      const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-01-05,Sales,INV-X,Alpha LLC,OM1100000011,100.000,5.000,104.995
`;
      const r = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        filename: 'bad-math.csv',
        file: Buffer.from(csv),
      });
      expect(r.rows).toHaveLength(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toMatch(/VAT math mismatch/);
      expect(r.errors[0].message).toMatch(/row 2/);
    });

    it('reports missing VATIN', async () => {
      const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-01-05,Sales,INV-X,Alpha LLC,,100.000,5.000,105.000
`;
      const r = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(csv),
      });
      expect(r.rows).toHaveLength(0);
      expect(r.errors[0].message).toMatch(/missing VATIN/);
    });

    it('reports invalid date', async () => {
      const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
nope,Sales,INV-X,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
      const r = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(csv),
      });
      expect(r.rows).toHaveLength(0);
      expect(r.errors[0].message).toMatch(/invalid.*invoice date/i);
    });

    it('accepts DD/MM/YYYY dates typical of Tally', async () => {
      const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
15/01/2026,Sales,INV-X,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
      const r = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(csv),
      });
      expect(r.errors).toEqual([]);
      expect(r.rows[0].invoiceDate).toBe('2026-01-15');
    });
  });

  describe('preview summary + idempotency', () => {
    it('summary counts totalRows / validRows / errorRows / duplicateRows', async () => {
      const r = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      expect(r.summary.totalRows).toBe(2);
      expect(r.summary.validRows).toBe(2);
      expect(r.summary.errorRows).toBe(0);
      expect(r.summary.duplicateRows).toBe(0);
      expect(r.previewToken).toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);
    });

    it('second preview of the same file after a commit flags every row as duplicate', async () => {
      const first = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      await svc.commit(firmA, ownerA, first.previewToken);

      const second = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      expect(second.summary.duplicateRows).toBe(2);
      expect(second.summary.validRows).toBe(0);
    });
  });

  describe('commit', () => {
    it('writes DRAFT invoices under the correct tenant', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      const out = await svc.commit(firmA, ownerA, prev.previewToken);
      expect(out.rowCountCommitted).toBe(2);

      const inv = await withFirmTenant(appDb, firmA, tenantA, (tx) =>
        tx.select().from(invoices).where(eq(invoices.tenantId, tenantA)),
      );
      expect(inv.length).toBe(2);
      for (const i of inv) {
        expect(i.status).toBe('DRAFT');
        expect(i.currency).toBe('OMR');
      }
    });

    it('commit after a second preview with every row duplicate writes zero invoices', async () => {
      const first = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      await svc.commit(firmA, ownerA, first.previewToken);

      const second = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      const out = await svc.commit(firmA, ownerA, second.previewToken);
      expect(out.rowCountCommitted).toBe(0);
      expect(out.rowCountSkipped).toBe(2);
      const inv = await withFirmTenant(appDb, firmA, tenantA, (tx) =>
        tx.select().from(invoices).where(eq(invoices.tenantId, tenantA)),
      );
      expect(inv.length).toBe(2);
    });

    it('records the batch with row hashes and firm/tenant', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'zoho_books_csv',
        file: Buffer.from(ZOHO_BOOKS_CSV),
      });
      const out = await svc.commit(firmA, ownerA, prev.previewToken);
      const batch = await withFirmTenant(appDb, firmA, tenantA, (tx) =>
        tx.select().from(importBatches).where(eq(importBatches.id, out.batchId)).limit(1),
      );
      expect(batch[0].firmId).toBe(firmA);
      expect(batch[0].tenantId).toBe(tenantA);
      expect(batch[0].sourceFormat).toBe('zoho_books_csv');
      expect(Array.isArray(batch[0].rowHashes)).toBe(true);
      expect((batch[0].rowHashes as string[]).length).toBe(2);
    });

    it('rejects an unknown or tampered preview token', async () => {
      await expect(svc.commit(firmA, ownerA, 'not-a-real-token')).rejects.toThrow(/Invalid|unknown/i);
    });

    it('rejects committing a preview minted by a DIFFERENT firm', async () => {
      // Firm A creates a preview for its tenant.
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      // Firm B tries to commit it — the service MUST refuse so leakage
      // is impossible even when the token is somehow exposed.
      await expect(svc.commit(firmB, ownerB, prev.previewToken)).rejects.toThrow();
    });

    it('emits firm.import.committed on successful commit', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      let captured: {
        firmId: string;
        tenantId: string;
        batchId: string;
        rowCount: number;
      } | null = null;
      events.once('firm.import.committed', (p) => {
        captured = p;
      });
      const out = await svc.commit(firmA, ownerA, prev.previewToken);
      // Allow one microtask for the synchronous emit listener.
      expect(captured).not.toBeNull();
      expect(captured!.firmId).toBe(firmA);
      expect(captured!.tenantId).toBe(tenantA);
      expect(captured!.batchId).toBe(out.batchId);
      expect(captured!.rowCount).toBe(2);
    });

    it('commits parsed Tally XML to DRAFT invoices', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_xml',
        file: Buffer.from(TALLY_XML),
      });
      expect(prev.summary.validRows).toBe(2);
      const out = await svc.commit(firmA, ownerA, prev.previewToken);
      expect(out.rowCountCommitted).toBe(2);
      const inv = await withFirmTenant(appDb, firmA, tenantA, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantA), eq(invoices.number, 'XML-1'))),
      );
      expect(inv).toHaveLength(1);
      expect(inv[0].status).toBe('DRAFT');
    });

    it('commits Zoho Books preview, grouped by Invoice ID', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'zoho_books_csv',
        file: Buffer.from(ZOHO_BOOKS_CSV),
      });
      const out = await svc.commit(firmA, ownerA, prev.previewToken);
      expect(out.rowCountCommitted).toBe(2);
      const inv = await withFirmTenant(appDb, firmA, tenantA, (tx) =>
        tx.select().from(invoices).where(eq(invoices.tenantId, tenantA)),
      );
      const numbers = inv.map((i) => i.number).sort();
      expect(numbers).toEqual(['ZB-001', 'ZB-002']);
    });

    it('saveMapping=true persists the edited mapping for future imports', async () => {
      const prev = await svc.preview(firmA, {
        tenantId: tenantA,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(TALLY_SALES_REGISTER_CSV),
      });
      const edited = { ...prev.mapping, description: 'Narration', supplierName: 'Party Ledger' };
      await svc.commit(firmA, ownerA, prev.previewToken, edited, true);
      const saved = await withFirm(appDb, firmA, (tx) =>
        tx
          .select()
          .from(importColumnMappings)
          .where(
            and(
              eq(importColumnMappings.firmId, firmA),
              eq(importColumnMappings.sourceFormat, 'tally_sales_register_csv'),
            ),
          )
          .limit(1),
      );
      expect(saved).toHaveLength(1);
      const m = saved[0].mappingJson as Record<string, string>;
      expect(m.supplierName).toBe('Party Ledger');
    });
  });

  describe('engagement guard', () => {
    it('refuses preview when firm has no engagement with tenant', async () => {
      await expect(
        svc.preview(firmA, {
          tenantId: tenantB,
          sourceFormat: 'tally_sales_register_csv',
          file: Buffer.from(TALLY_SALES_REGISTER_CSV),
        }),
      ).rejects.toThrow();
    });
  });
});
