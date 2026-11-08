import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { posSales, posSaleLines } from '../../db/schema/pos';
import { invoices, invoiceLines, parties } from '../../db/schema/invoicing';
import { computeTotals, type LineInput } from '../invoices/money';
import type { CreateSaleDto } from './dto/create-sale.dto';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Atomically allocate the next sequence value for (tenant, scope, bucket).
 * Uses INSERT ... ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING seq, which:
 *   - takes a row-level lock on contention,
 *   - produces a monotonic result per (tenant_id, scope, bucket) with no gaps between
 *     concurrent committers (each caller gets a distinct seq),
 *   - avoids the race window of max+1.
 */
async function nextSeq(tx: Tx, tenantId: string, scope: string, bucket: string): Promise<number> {
  const result = await tx.execute(sql`
    INSERT INTO pos_number_sequences (tenant_id, scope, bucket, seq)
    VALUES (${tenantId}, ${scope}, ${bucket}, 1)
    ON CONFLICT (tenant_id, scope, bucket)
    DO UPDATE SET seq = pos_number_sequences.seq + 1
    RETURNING seq
  `);
  const rows = (result as unknown as { rows: Array<{ seq: number }> }).rows;
  if (!rows || rows.length === 0) throw new Error('Failed to allocate sequence');
  return Number(rows[0].seq);
}

interface SaleFilters {
  from?: string;
  to?: string;
  status?: string;
}

@Injectable()
export class SalesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async createSale(tenantId: string, userId: string | null, dto: CreateSaleDto) {
    const totals = computeTotals(
      dto.lines.map<LineInput>((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatCategory: l.vatCategory ?? 'S',
        vatRate: l.vatRate ?? 5,
      })),
    );
    const now = new Date();
    const bucket = yyyymmdd(now);

    return withTenant(this.db, tenantId, async (tx) => {
      const seq = await nextSeq(tx, tenantId, 'pos_sale', bucket);
      const number = `POS-${bucket}-${seq.toString().padStart(4, '0')}`;

      const [sale] = await tx
        .insert(posSales)
        .values({
          tenantId,
          number,
          soldAt: now,
          subtotal: totals.subtotal.toFixed(3),
          vatTotal: totals.vatTotal.toFixed(3),
          grandTotal: totals.grandTotal.toFixed(3),
          tenderMethod: dto.tenderMethod,
          tenderCash: (dto.tenderCash ?? 0).toFixed(3),
          tenderCard: (dto.tenderCard ?? 0).toFixed(3),
          changeGiven: (dto.changeGiven ?? 0).toFixed(3),
          clearanceStatus: 'PENDING_BATCH',
          soldBy: userId ?? null,
        })
        .returning();

      const lineRows = dto.lines.map((l, i) => ({
        tenantId,
        saleId: sale.id,
        lineNo: i + 1,
        productId: l.productId ?? null,
        description: l.description,
        quantity: l.quantity.toFixed(3),
        unitPrice: l.unitPrice.toFixed(3),
        vatCategory: l.vatCategory ?? 'S',
        vatRate: (l.vatRate ?? 5).toFixed(2),
        lineNet: totals.lineNets[i].toFixed(3),
      }));
      await tx.insert(posSaleLines).values(lineRows);
      return { ...sale, lines: lineRows };
    });
  }

  list(tenantId: string, filters: SaleFilters = {}) {
    return withTenant(this.db, tenantId, (tx) => {
      const conds = [];
      if (filters.status) conds.push(eq(posSales.clearanceStatus, filters.status));
      if (filters.from) conds.push(gte(posSales.soldAt, new Date(filters.from)));
      if (filters.to) conds.push(lte(posSales.soldAt, new Date(filters.to)));
      const q = tx.select().from(posSales);
      const withWhere = conds.length ? q.where(and(...conds)) : q;
      return withWhere.orderBy(desc(posSales.soldAt));
    });
  }

  get(tenantId: string, id: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [sale] = await tx.select().from(posSales).where(eq(posSales.id, id)).limit(1);
      if (!sale) throw new NotFoundException('Sale not found');
      const lines = await tx
        .select()
        .from(posSaleLines)
        .where(eq(posSaleLines.saleId, id))
        .orderBy(asc(posSaleLines.lineNo));
      return { ...sale, lines };
    });
  }

  /**
   * Group all PENDING_BATCH sales for this tenant with sold_at <= cutoffAt into one
   * B2C summary invoice. Produces one aggregate line per (vat_category, vat_rate):
   *   - description: "B2C aggregate - {category}"
   *   - quantity: 1
   *   - unit_price: sum of each sale's grand_total share for that category
   * Marks every batched sale as BATCHED and sets invoice_id.
   *
   * For the summary invoice the supplier party is the tenant's own 'self' party and the
   * buyer is a 'customer' party named 'B2C aggregate' (both auto-provisioned if missing).
   */
  async batchPendingToInvoice(tenantId: string, cutoffAtInput?: string) {
    const cutoffAt = cutoffAtInput ? new Date(cutoffAtInput) : new Date();
    const bucket = yyyymmdd(cutoffAt);

    return withTenant(this.db, tenantId, async (tx) => {
      const pending = await tx
        .select()
        .from(posSales)
        .where(and(eq(posSales.clearanceStatus, 'PENDING_BATCH'), lte(posSales.soldAt, cutoffAt)))
        .orderBy(asc(posSales.soldAt));
      if (pending.length === 0) {
        throw new BadRequestException('No pending sales to batch');
      }

      const saleIds = pending.map((s) => s.id);
      const lines = await tx
        .select()
        .from(posSaleLines)
        .where(inArray(posSaleLines.saleId, saleIds));

      // aggregate (vatCategory, vatRate) -> {taxable, tax}
      const groups = new Map<
        string,
        { category: string; rate: number; taxableMinor: number; taxMinor: number }
      >();
      for (const l of lines) {
        const quantity = Number(l.quantity);
        const unitPrice = Number(l.unitPrice);
        const rate = Number(l.vatRate);
        const category = l.vatCategory;
        const lineNet = Math.round(quantity * Math.round(unitPrice * 1000));
        const tax = Math.round((lineNet * rate) / 100);
        const key = `${category}|${rate}`;
        const g = groups.get(key) ?? { category, rate, taxableMinor: 0, taxMinor: 0 };
        g.taxableMinor += lineNet;
        g.taxMinor += tax;
        groups.set(key, g);
      }

      // ensure a self party and a 'B2C aggregate' customer exist for this tenant
      let [selfParty] = await tx.select().from(parties).where(eq(parties.kind, 'self')).limit(1);
      if (!selfParty) {
        [selfParty] = await tx
          .insert(parties)
          .values({ tenantId, kind: 'self', name: 'Self', country: 'OM' })
          .returning();
      }
      let [b2cParty] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.kind, 'customer'), eq(parties.name, 'B2C aggregate')))
        .limit(1);
      if (!b2cParty) {
        [b2cParty] = await tx
          .insert(parties)
          .values({
            tenantId,
            kind: 'customer',
            name: 'B2C aggregate',
            country: 'OM',
          })
          .returning();
      }

      // allocate the daily B2C invoice number
      const seq = await nextSeq(tx, tenantId, 'b2c_invoice', bucket);
      const invoiceNumber = `B2C-${bucket}-${seq.toString().padStart(3, '0')}`;

      const totalLines: LineInput[] = [];
      const descriptions: string[] = [];
      for (const g of groups.values()) {
        const amount = (g.taxableMinor + g.taxMinor) / 1000;
        const grossUnitPrice = amount; // single line, quantity 1
        // reverse-compute net unit price from gross: net = gross / (1 + rate/100)
        const netUnit = g.rate === 0 ? grossUnitPrice : grossUnitPrice / (1 + g.rate / 100);
        totalLines.push({
          quantity: 1,
          unitPrice: Number(netUnit.toFixed(3)),
          vatCategory: g.category,
          vatRate: g.rate,
        });
        descriptions.push(`B2C aggregate - ${g.category}`);
      }
      const totals = computeTotals(totalLines);

      const [invoice] = await tx
        .insert(invoices)
        .values({
          tenantId,
          type: 'invoice',
          number: invoiceNumber,
          issueDate: cutoffAt.toISOString().slice(0, 10),
          supplierPartyId: selfParty.id,
          buyerPartyId: b2cParty.id,
          currency: 'OMR',
          notes: `B2C aggregate of ${pending.length} POS sales up to ${cutoffAt.toISOString()}`,
          subtotal: totals.subtotal.toFixed(3),
          vatTotal: totals.vatTotal.toFixed(3),
          grandTotal: totals.grandTotal.toFixed(3),
          vatBreakdown: totals.vatBreakdown,
        })
        .returning();

      const invoiceLineRows = totalLines.map((l, i) => ({
        tenantId,
        invoiceId: invoice.id,
        lineNo: i + 1,
        description: descriptions[i],
        quantity: l.quantity.toFixed(3),
        unitCode: 'C62',
        unitPrice: l.unitPrice.toFixed(3),
        vatCategory: l.vatCategory,
        vatRate: l.vatRate.toFixed(2),
        lineNet: totals.lineNets[i].toFixed(3),
      }));
      if (invoiceLineRows.length > 0) {
        await tx.insert(invoiceLines).values(invoiceLineRows);
      }

      await tx
        .update(posSales)
        .set({ clearanceStatus: 'BATCHED', invoiceId: invoice.id })
        .where(inArray(posSales.id, saleIds));

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        batchedCount: pending.length,
        subtotal: Number(invoice.subtotal),
        vatTotal: Number(invoice.vatTotal),
        grandTotal: Number(invoice.grandTotal),
      };
    });
  }

  /**
   * Z-report: total sales for a given day (UTC), by tender method, by vat category,
   * and the expected cash drawer balance.
   */
  endOfDayReport(tenantId: string, dateIso: string) {
    const date = new Date(`${dateIso}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);

    return withTenant(this.db, tenantId, async (tx) => {
      const sales = await tx
        .select()
        .from(posSales)
        .where(and(gte(posSales.soldAt, date), lte(posSales.soldAt, next)))
        .orderBy(asc(posSales.soldAt));
      const saleIds = sales.map((s) => s.id);
      const lines = saleIds.length
        ? await tx.select().from(posSaleLines).where(inArray(posSaleLines.saleId, saleIds))
        : [];

      let totalMinor = 0;
      let vatMinor = 0;
      let cashMinor = 0;
      let changeMinor = 0;
      const byTender: Record<string, { count: number; totalMinor: number }> = {
        cash: { count: 0, totalMinor: 0 },
        card: { count: 0, totalMinor: 0 },
        mixed: { count: 0, totalMinor: 0 },
      };
      for (const s of sales) {
        const g = Math.round(Number(s.grandTotal) * 1000);
        totalMinor += g;
        vatMinor += Math.round(Number(s.vatTotal) * 1000);
        cashMinor += Math.round(Number(s.tenderCash) * 1000);
        changeMinor += Math.round(Number(s.changeGiven) * 1000);
        const bucket = byTender[s.tenderMethod] ?? { count: 0, totalMinor: 0 };
        bucket.count += 1;
        bucket.totalMinor += g;
        byTender[s.tenderMethod] = bucket;
      }

      const byCategory = new Map<
        string,
        { category: string; rate: number; taxableMinor: number; taxMinor: number }
      >();
      for (const l of lines) {
        const quantity = Number(l.quantity);
        const unitPrice = Number(l.unitPrice);
        const rate = Number(l.vatRate);
        const category = l.vatCategory;
        const lineNet = Math.round(quantity * Math.round(unitPrice * 1000));
        const tax = Math.round((lineNet * rate) / 100);
        const key = `${category}|${rate}`;
        const g = byCategory.get(key) ?? { category, rate, taxableMinor: 0, taxMinor: 0 };
        g.taxableMinor += lineNet;
        g.taxMinor += tax;
        byCategory.set(key, g);
      }

      const cashDrawerExpectedMinor = cashMinor - changeMinor;
      return {
        date: dateIso,
        salesCount: sales.length,
        total: totalMinor / 1000,
        vatTotal: vatMinor / 1000,
        byTender: Object.fromEntries(
          Object.entries(byTender).map(([k, v]) => [
            k,
            { count: v.count, total: v.totalMinor / 1000 },
          ]),
        ),
        byVatCategory: Array.from(byCategory.values()).map((g) => ({
          category: g.category,
          rate: g.rate,
          taxable: g.taxableMinor / 1000,
          tax: g.taxMinor / 1000,
        })),
        cashDrawerExpected: cashDrawerExpectedMinor / 1000,
      };
    });
  }
}
