/**
 * EP5 Wave 2 (W2-D) — RLS enforcement for firm-scoped import tables.
 *
 * Covers:
 *   - import_column_mappings is firm-isolated (firm A cannot read or
 *     write firm B's mapping)
 *   - import_batches is tenant-isolated on the WITH CHECK path
 *   - import_batches firm-SELECT branch lets the firm read its own
 *     batches but never a sibling firm's
 *   - withFirmTenant refuses cross-tenant commits
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../src/db/schema';
import { withFirm } from '../src/db/with-firm';
import { withTenant } from '../src/db/with-tenant';
import { importBatches, importColumnMappings } from '../src/db/schema/firm-imports';
import { ColumnMappingService } from '../src/modules/imports/column-mapping.service';
import { FirmImportsService } from '../src/modules/imports/firm-imports.service';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('Firm Imports — RLS (W2-D)', () => {
  const firmA = randomUUID();
  const firmB = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let svc: FirmImportsService;
  let mappings: ColumnMappingService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO users (id, cognito_sub, email) VALUES ($1,$2,$3),($4,$5,$6)`, [
      ownerA,
      `sub-${ownerA}`,
      `rls-A-${ownerA}@test`,
      ownerB,
      `sub-${ownerB}`,
      `rls-B-${ownerB}@test`,
    ]);
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1,'RLS TA'),($2,'RLS TB')`, [
      tenantA,
      tenantB,
    ]);
    await admin.query(`INSERT INTO firms (id, name) VALUES ($1,'RLS Firm A'),($2,'RLS Firm B')`, [
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
    svc = new FirmImportsService(appDb, mappings);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM import_batches WHERE firm_id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM import_column_mappings WHERE firm_id IN ($1,$2)`, [
      firmA,
      firmB,
    ]);
    await admin.query(`DELETE FROM invoices WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM parties WHERE tenant_id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM firms WHERE id IN ($1,$2)`, [firmA, firmB]);
    await admin.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenantA, tenantB]);
    await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [ownerA, ownerB]);
    await appPool.end();
    await admin.end();
  });

  it('import_column_mappings RLS: firm A cannot see firm B mapping', async () => {
    await mappings.saveForFirm(firmB, 'zoho_books_csv', {
      invoiceNumber: 'Invoice ID',
      invoiceDate: 'Invoice Date',
      buyerName: 'Customer Name',
      buyerVatin: 'Customer VATIN',
      taxableAmount: 'Taxable Amount',
      vatAmount: 'VAT Amount',
      totalAmount: 'Total',
    });
    const rows = await withFirm(appDb, firmA, (tx) =>
      tx.select().from(importColumnMappings).where(eq(importColumnMappings.firmId, firmB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('import_column_mappings RLS: firm A cannot INSERT a mapping for firm B', async () => {
    await expect(
      withFirm(appDb, firmA, (tx) =>
        tx.insert(importColumnMappings).values({
          firmId: firmB,
          sourceFormat: 'zoho_books_csv',
          mappingJson: { invoiceNumber: 'X' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('firm A cannot commit into firm B tenant (engagement check)', async () => {
    const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-03-01,Sales,CROSS-1,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
    await expect(
      svc.preview(firmA, {
        tenantId: tenantB,
        sourceFormat: 'tally_sales_register_csv',
        file: Buffer.from(csv),
      }),
    ).rejects.toThrow();
  });

  it('import_batches tenant RLS: tenant B context cannot see tenant A batch', async () => {
    const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-04-01,Sales,T-A-ONLY,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
    const prev = await svc.preview(firmA, {
      tenantId: tenantA,
      sourceFormat: 'tally_sales_register_csv',
      file: Buffer.from(csv),
    });
    await svc.commit(firmA, ownerA, prev.previewToken);
    const viaB = await withTenant(appDb, tenantB, (tx) => tx.select().from(importBatches));
    expect(viaB).toHaveLength(0);
    const viaA = await withTenant(appDb, tenantA, (tx) => tx.select().from(importBatches));
    expect(viaA.length).toBeGreaterThan(0);
  });

  it('import_batches firm-SELECT branch: firm context sees its own batch', async () => {
    const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-04-02,Sales,FIRM-SEL-1,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
    const prev = await svc.preview(firmA, {
      tenantId: tenantA,
      sourceFormat: 'tally_sales_register_csv',
      file: Buffer.from(csv),
    });
    const out = await svc.commit(firmA, ownerA, prev.previewToken);
    const rows = await withFirm(appDb, firmA, (tx) =>
      tx.select().from(importBatches).where(eq(importBatches.id, out.batchId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('import_batches firm-SELECT branch: firm B cannot see firm A batch', async () => {
    const csv = `Date,Voucher Type,Voucher No.,Party Ledger,Party VATIN,Taxable Amount,VAT Amount,Total Amount
2026-04-03,Sales,FIRM-ISO-1,Alpha LLC,OM1100000011,100.000,5.000,105.000
`;
    const prev = await svc.preview(firmA, {
      tenantId: tenantA,
      sourceFormat: 'tally_sales_register_csv',
      file: Buffer.from(csv),
    });
    const out = await svc.commit(firmA, ownerA, prev.previewToken);
    const rows = await withFirm(appDb, firmB, (tx) =>
      tx.select().from(importBatches).where(eq(importBatches.id, out.batchId)),
    );
    expect(rows).toHaveLength(0);
  });
});
