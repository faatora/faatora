import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type Database } from '../src/db/db.module';
import { withTenant } from '../src/db/with-tenant';
import { ProductsService } from '../src/modules/pos/products.service';
import { SalesService } from '../src/modules/pos/sales.service';
import { posSales, products as productsTable } from '../src/db/schema/pos';
import { invoices } from '../src/db/schema/invoicing';
import * as schema from '../src/db/schema';

const APP_URL = process.env.DATABASE_URL as string;
const ADMIN_URL = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) as string;

describe('POS module', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  let admin: Pool;
  let appPool: Pool;
  let appDb: Database;
  let products: ProductsService;
  let sales: SalesService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, 'POS-T1'), ($2, 'POS-T2')`, [
      t1,
      t2,
    ]);

    appPool = new Pool({ connectionString: APP_URL });
    appDb = drizzle(appPool, { schema });
    products = new ProductsService(appDb);
    sales = new SalesService(appDb);
  });

  afterAll(async () => {
    // tenant cascade cleans products / sales / invoices / parties for these tenants
    await admin.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [t1, t2]);
    await appPool.end();
    await admin.end();
  });

  it('creates a sale with 2 lines and computes totals', async () => {
    const sale = await sales.createSale(t1, null, {
      tenderMethod: 'cash',
      tenderCash: 50,
      changeGiven: 18.5,
      lines: [
        { description: 'Coffee', quantity: 3, unitPrice: 5, vatCategory: 'S', vatRate: 5 },
        { description: 'Water', quantity: 2, unitPrice: 2, vatCategory: 'S', vatRate: 5 },
      ],
    });
    expect(sale.number).toMatch(/^POS-\d{8}-\d{4}$/);
    expect(Number(sale.subtotal)).toBe(19);
    expect(Number(sale.vatTotal)).toBe(0.95);
    expect(Number(sale.grandTotal)).toBe(19.95);
    expect(sale.clearanceStatus).toBe('PENDING_BATCH');
    expect(sale.lines).toHaveLength(2);
  });

  it('allocates monotonic unique sale numbers per tenant', async () => {
    const a = await sales.createSale(t1, null, {
      tenderMethod: 'cash',
      lines: [{ description: 'X', quantity: 1, unitPrice: 1 }],
    });
    const b = await sales.createSale(t1, null, {
      tenderMethod: 'cash',
      lines: [{ description: 'Y', quantity: 1, unitPrice: 2 }],
    });
    expect(a.number).not.toBe(b.number);
    // tenant 2 numbers are allocated independently (also unique within t2)
    const c = await sales.createSale(t2, null, {
      tenderMethod: 'cash',
      lines: [{ description: 'Z', quantity: 1, unitPrice: 3 }],
    });
    expect(c.number).toMatch(/^POS-\d{8}-\d{4}$/);
    // a and b both belong to t1 and share the daily bucket -> their seq must differ
    const [, bucketA, seqA] = a.number.split('-');
    const [, bucketB, seqB] = b.number.split('-');
    expect(bucketA).toBe(bucketB);
    expect(Number(seqB)).toBe(Number(seqA) + 1);
  });

  it('batches pending sales into one B2C summary invoice', async () => {
    // Scope: use a fresh tenant so prior tests do not interfere.
    const t3 = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, 'POS-T3')`, [t3]);
    try {
      await sales.createSale(t3, null, {
        tenderMethod: 'cash',
        lines: [{ description: 'A', quantity: 2, unitPrice: 10, vatCategory: 'S', vatRate: 5 }],
      });
      await sales.createSale(t3, null, {
        tenderMethod: 'card',
        lines: [{ description: 'B', quantity: 1, unitPrice: 20, vatCategory: 'S', vatRate: 5 }],
      });
      await sales.createSale(t3, null, {
        tenderMethod: 'cash',
        lines: [{ description: 'C', quantity: 1, unitPrice: 7, vatCategory: 'Z', vatRate: 0 }],
      });

      const result = await sales.batchPendingToInvoice(t3);
      expect(result.batchedCount).toBe(3);
      expect(result.invoiceNumber).toMatch(/^B2C-\d{8}-\d{3}$/);

      // All sales flipped to BATCHED and point at the invoice
      const remaining = await withTenant(appDb, t3, (tx) =>
        tx.select().from(posSales).where(eq(posSales.clearanceStatus, 'PENDING_BATCH')),
      );
      expect(remaining).toHaveLength(0);
      const batched = await withTenant(appDb, t3, (tx) =>
        tx.select().from(posSales).where(eq(posSales.clearanceStatus, 'BATCHED')),
      );
      expect(batched).toHaveLength(3);
      for (const s of batched) {
        expect(s.invoiceId).not.toBeNull();
      }

      // Exactly one invoice created, grand_total equals sum of sale grand_totals.
      const invs = await withTenant(appDb, t3, (tx) =>
        tx.select().from(invoices).where(eq(invoices.number, result.invoiceNumber)),
      );
      expect(invs).toHaveLength(1);
      const saleTotal = batched.reduce((a, s) => a + Number(s.grandTotal), 0);
      expect(Number(invs[0].grandTotal)).toBeCloseTo(saleTotal, 2);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [t3]);
    }
  });

  it('Z-report sums totals, tender breakdown and cash drawer', async () => {
    const t4 = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, 'POS-T4')`, [t4]);
    try {
      const s1 = await sales.createSale(t4, null, {
        tenderMethod: 'cash',
        tenderCash: 30,
        changeGiven: 10,
        lines: [{ description: 'A', quantity: 2, unitPrice: 10, vatCategory: 'S', vatRate: 5 }],
      });
      const s2 = await sales.createSale(t4, null, {
        tenderMethod: 'card',
        tenderCard: 15,
        lines: [{ description: 'B', quantity: 1, unitPrice: 15, vatCategory: 'S', vatRate: 5 }],
      });
      const today = new Date().toISOString().slice(0, 10);
      const z = await sales.endOfDayReport(t4, today);
      expect(z.salesCount).toBe(2);
      expect(z.total).toBeCloseTo(Number(s1.grandTotal) + Number(s2.grandTotal), 3);
      expect(z.byTender.cash.count).toBe(1);
      expect(z.byTender.card.count).toBe(1);
      expect(z.byTender.cash.total).toBeCloseTo(Number(s1.grandTotal), 3);
      expect(z.cashDrawerExpected).toBeCloseTo(30 - 10, 3);
      const standard = z.byVatCategory.find((c) => c.category === 'S');
      expect(standard).toBeDefined();
      expect(standard!.taxable).toBeCloseTo(35, 3);
    } finally {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [t4]);
    }
  });

  it('isolates products across tenants (RLS)', async () => {
    const p1 = await products.create(t1, {
      sku: 'ISO-1',
      nameEn: 'Isolated',
      unitPrice: 1,
    });
    expect(p1.id).toBeDefined();
    // from t2 we cannot see or fetch t1's product
    const fromT2 = await withTenant(appDb, t2, (tx) =>
      tx.select().from(productsTable).where(eq(productsTable.id, p1.id)),
    );
    expect(fromT2).toHaveLength(0);
    const byBarcode = await products.findBySku(t2, 'ISO-1');
    expect(byBarcode).toBeNull();
    // and inserting a row claiming the other tenant is rejected by the WITH CHECK policy
    await expect(
      withTenant(appDb, t2, (tx) =>
        tx.insert(productsTable).values({
          tenantId: t1,
          sku: 'CROSS',
          nameEn: 'cross',
          unitPrice: '1.000',
        }),
      ),
    ).rejects.toThrow();
    // sanity: t1 still sees its own product and the earlier sales
    const own = await withTenant(appDb, t1, (tx) =>
      tx
        .select()
        .from(productsTable)
        .where(and(eq(productsTable.id, p1.id))),
    );
    expect(own).toHaveLength(1);
  });
});
