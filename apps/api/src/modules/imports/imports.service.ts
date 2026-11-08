import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withTenant } from '../../db/with-tenant';
import { parties, invoices, invoiceLines } from '../../db/schema/invoicing';
import { importJobs, importErrors } from '../../db/schema/imports';
import { computeTotals, type LineInput } from '../invoices/money';
import { parseCsv } from './parsers/csv.parser';
import { parseExcel } from './parsers/excel.parser';
import { parseTallyXml } from './parsers/tally.parser';
import type { ParseError, ParseResult, ParsedRow } from './parsers/types';

export type ImportSource = 'csv' | 'excel' | 'tally_xml';

interface InvoiceGroup {
  number: string;
  issueDate: string;
  supplierVatin?: string;
  supplierName: string;
  buyerVatin?: string;
  buyerName: string;
  firstRowNo: number;
  rows: ParsedRow[];
}

export interface ImportSummary {
  jobId: string;
  status: string;
  totalRows: number;
  importedRows: number;
  errorRows: number;
}

@Injectable()
export class ImportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  private async parse(source: ImportSource, buffer: Buffer): Promise<ParseResult> {
    if (source === 'csv') return parseCsv(buffer);
    if (source === 'excel') return parseExcel(buffer);
    return parseTallyXml(buffer);
  }

  private groupByInvoice(rows: ParsedRow[]): InvoiceGroup[] {
    const map = new Map<string, InvoiceGroup>();
    for (const r of rows) {
      const existing = map.get(r.number);
      if (existing) {
        existing.rows.push(r);
      } else {
        map.set(r.number, {
          number: r.number,
          issueDate: r.issueDate,
          supplierVatin: r.supplierVatin,
          supplierName: r.supplierName,
          buyerVatin: r.buyerVatin,
          buyerName: r.buyerName,
          firstRowNo: r.rowNo,
          rows: [r],
        });
      }
    }
    return Array.from(map.values());
  }

  async startImport(
    tenantId: string,
    userId: string,
    source: ImportSource,
    filename: string | undefined,
    buffer: Buffer,
  ): Promise<ImportSummary> {
    // Create job (processing) first — using the admin pool via withTenant.
    const [job] = await withTenant(this.db, tenantId, (tx) =>
      tx
        .insert(importJobs)
        .values({
          tenantId,
          source,
          originalFilename: filename,
          status: 'processing',
          startedAt: new Date(),
          createdBy: userId,
        })
        .returning(),
    );
    const jobId = job.id;
    const parsed = await this.parse(source, buffer);
    const errors: ParseError[] = [...parsed.errors];
    const groups = this.groupByInvoice(parsed.rows);
    let imported = 0;
    for (const group of groups) {
      try {
        await withTenant(this.db, tenantId, async (tx) => {
          // For Tally imports supplierName is empty — use buyer party only in that case,
          // defaulting the supplier to a "Self" tenant-owned party.
          const supplierName = group.supplierName || 'Self';
          const supplierParty = await this.findOrCreateParty(
            tx,
            tenantId,
            group.supplierVatin,
            supplierName,
            'supplier',
          );
          const buyerParty = await this.findOrCreateParty(
            tx,
            tenantId,
            group.buyerVatin,
            group.buyerName,
            'customer',
          );
          const lineInputs: LineInput[] = group.rows.map((r) => ({
            quantity: r.lineQuantity,
            unitPrice: r.lineUnitPrice,
            vatCategory: r.lineVatCategory,
            vatRate: r.lineVatRate,
          }));
          const totals = computeTotals(lineInputs);
          const [inv] = await tx
            .insert(invoices)
            .values({
              tenantId,
              type: 'invoice',
              number: group.number,
              issueDate: group.issueDate,
              supplierPartyId: supplierParty.id,
              buyerPartyId: buyerParty.id,
              currency: 'OMR',
              createdBy: userId,
              subtotal: totals.subtotal.toFixed(3),
              vatTotal: totals.vatTotal.toFixed(3),
              grandTotal: totals.grandTotal.toFixed(3),
              vatBreakdown: totals.vatBreakdown,
            })
            .returning();
          const lineValues = group.rows.map((r, i) => ({
            tenantId,
            invoiceId: inv.id,
            lineNo: i + 1,
            description: r.lineDescription,
            quantity: r.lineQuantity.toFixed(3),
            unitCode: 'C62',
            unitPrice: r.lineUnitPrice.toFixed(3),
            vatCategory: r.lineVatCategory,
            vatRate: r.lineVatRate.toFixed(2),
            lineNet: totals.lineNets[i].toFixed(3),
          }));
          await tx.insert(invoiceLines).values(lineValues);
        });
        imported++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        errors.push({
          rowNo: group.firstRowNo,
          columnName: 'number',
          rawValue: group.number,
          message: `Failed to import invoice ${group.number}: ${message}`,
        });
      }
    }
    // Persist errors and update job.
    const totalRows = parsed.rows.length + parsed.errors.length;
    await withTenant(this.db, tenantId, async (tx) => {
      if (errors.length > 0) {
        await tx.insert(importErrors).values(
          errors.map((e) => ({
            tenantId,
            jobId,
            rowNo: e.rowNo,
            columnName: e.columnName,
            rawValue: e.rawValue,
            message: e.message,
          })),
        );
      }
      const finalStatus = imported === 0 && errors.length > 0 ? 'failed' : 'completed';
      await tx
        .update(importJobs)
        .set({
          status: finalStatus,
          totalRows,
          importedRows: imported,
          errorRows: errors.length,
          finishedAt: new Date(),
        })
        .where(eq(importJobs.id, jobId));
    });
    const finalStatus = imported === 0 && errors.length > 0 ? 'failed' : 'completed';
    return {
      jobId,
      status: finalStatus,
      totalRows,
      importedRows: imported,
      errorRows: errors.length,
    };
  }

  private async findOrCreateParty(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    tenantId: string,
    vatin: string | undefined,
    name: string,
    kind: string,
  ): Promise<{ id: string }> {
    // Match by vatin first (strongest signal), then fall back to case-insensitive name.
    if (vatin && vatin.trim()) {
      const vat = vatin.trim();
      const byVat = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.vatin, vat)))
        .limit(1);
      if (byVat[0]) return byVat[0];
    }
    const byName = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.name, name)))
      .limit(1);
    if (byName[0]) return byName[0];
    const [created] = await tx
      .insert(parties)
      .values({
        tenantId,
        kind,
        name,
        vatin: vatin && vatin.trim() ? vatin.trim() : null,
        country: 'OM',
      })
      .returning({ id: parties.id });
    return created;
  }

  listJobs(tenantId: string) {
    return withTenant(this.db, tenantId, (tx) =>
      tx.select().from(importJobs).orderBy(desc(importJobs.createdAt)),
    );
  }

  getJobWithErrors(tenantId: string, jobId: string) {
    return withTenant(this.db, tenantId, async (tx) => {
      const [job] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
      if (!job) throw new NotFoundException('Import job not found');
      const errs = await tx
        .select()
        .from(importErrors)
        .where(eq(importErrors.jobId, jobId))
        .orderBy(asc(importErrors.rowNo))
        .limit(500);
      return { ...job, errors: errs };
    });
  }
}
