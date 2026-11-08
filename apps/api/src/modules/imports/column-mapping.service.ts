/**
 * W2-D — column mapping service.
 *
 * A column mapping is a dict from CANONICAL ParsedImportRow field names
 * to the SOURCE column header (or XML path) the parser emits. Example
 * for Zoho Books:
 *   { invoiceNumber: "Invoice ID",
 *     invoiceDate:   "Invoice Date",
 *     buyerName:     "Customer Name",
 *     buyerVatin:    "Customer VATIN",
 *     taxableAmount: "Taxable Amount",
 *     vatAmount:     "VAT Amount",
 *     totalAmount:   "Total" }
 *
 * The parser emits raw rows keyed by the SOURCE headers. This service
 * applies a mapping to each raw row to produce a ParsedImportRow, and
 * also runs the validation sweep the preview endpoint reports on.
 *
 * Defaults ship for each source format. Firms override through the
 * save() call, which upserts into import_column_mappings under the
 * firm's RLS context.
 */

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import { importColumnMappings } from '../../db/schema/firm-imports';
import type {
  ImportSourceFormat,
  ParsedImportResult,
  ParsedImportRow,
  RawRow,
  RowError,
} from './parsers/parsed-import-row';

export type ColumnMapping = Partial<Record<keyof ParsedImportRow, string>> & {
  // Allow extra keys for forward compatibility (e.g. `currencyColumn`).
  [extra: string]: string | undefined;
};

export const DEFAULT_MAPPINGS: Record<ImportSourceFormat, ColumnMapping> = {
  tally_sales_register_csv: {
    invoiceNumber: 'Voucher No.',
    invoiceDate: 'Date',
    buyerName: 'Party Ledger',
    buyerVatin: 'Party VATIN',
    taxableAmount: 'Taxable Amount',
    vatAmount: 'VAT Amount',
    totalAmount: 'Total Amount',
    description: 'Narration',
  },
  tally_daybook_csv: {
    // The Day Book parser rewrites headers to the Sales Register vocab
    // so the mapping is intentionally identical. A firm override may
    // repoint the fields if their Day Book export uses non-standard
    // ledger naming.
    invoiceNumber: 'Voucher No.',
    invoiceDate: 'Date',
    buyerName: 'Party Ledger',
    buyerVatin: 'Party VATIN',
    taxableAmount: 'Taxable Amount',
    vatAmount: 'VAT Amount',
    totalAmount: 'Total Amount',
    description: 'Narration',
  },
  tally_xml: {
    invoiceNumber: 'Voucher No.',
    invoiceDate: 'Date',
    buyerName: 'Party Ledger',
    buyerVatin: 'Party VATIN',
    taxableAmount: 'Taxable Amount',
    vatAmount: 'VAT Amount',
    totalAmount: 'Total Amount',
    description: 'Narration',
  },
  zoho_books_csv: {
    invoiceNumber: 'Invoice ID',
    invoiceDate: 'Invoice Date',
    buyerName: 'Customer Name',
    buyerVatin: 'Customer VATIN',
    taxableAmount: 'Taxable Amount',
    vatAmount: 'VAT Amount',
    totalAmount: 'Total',
    description: 'Item Name',
  },
};

const VAT_RECONCILE_TOLERANCE = 0.001;

function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO 8601 YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const sliced = s.slice(0, 10);
    const d = new Date(sliced + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? null : sliced;
  }
  // Tally: DD-MM-YYYY or DD/MM/YYYY.
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? null
      : `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // Tally YYYYMMDD compact.
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const s = raw.replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readCell(row: RawRow, mapping: ColumnMapping, canonicalField: string): string {
  const sourceColumn = mapping[canonicalField];
  if (!sourceColumn) return '';
  return (row.cells[sourceColumn] ?? '').toString().trim();
}

@Injectable()
export class ColumnMappingService {
  constructor(@Inject(DB) private readonly db: Database) {}

  getDefault(sourceFormat: ImportSourceFormat): ColumnMapping {
    return { ...DEFAULT_MAPPINGS[sourceFormat] };
  }

  async getForFirm(
    firmId: string,
    sourceFormat: ImportSourceFormat,
  ): Promise<ColumnMapping> {
    const rows = await withFirm(this.db, firmId, (tx) =>
      tx
        .select()
        .from(importColumnMappings)
        .where(
          and(
            eq(importColumnMappings.firmId, firmId),
            eq(importColumnMappings.sourceFormat, sourceFormat),
          ),
        )
        .limit(1),
    );
    if (rows[0]) {
      return rows[0].mappingJson as ColumnMapping;
    }
    return this.getDefault(sourceFormat);
  }

  async saveForFirm(
    firmId: string,
    sourceFormat: ImportSourceFormat,
    mapping: ColumnMapping,
  ): Promise<ColumnMapping> {
    return withFirm(this.db, firmId, async (tx) => {
      const existing = await tx
        .select()
        .from(importColumnMappings)
        .where(
          and(
            eq(importColumnMappings.firmId, firmId),
            eq(importColumnMappings.sourceFormat, sourceFormat),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await tx
          .update(importColumnMappings)
          .set({ mappingJson: mapping, updatedAt: new Date() })
          .where(eq(importColumnMappings.id, existing[0].id));
      } else {
        await tx.insert(importColumnMappings).values({
          firmId,
          sourceFormat,
          mappingJson: mapping,
        });
      }
      return mapping;
    });
  }

  /**
   * Apply a column mapping to the parser's raw rows and run per-row
   * validation (required fields, parseable date, VAT math within
   * tolerance). Returns both the valid ParsedImportRow[] and the
   * errors.
   */
  applyMapping(rawRows: RawRow[], mapping: ColumnMapping): ParsedImportResult {
    const rows: ParsedImportRow[] = [];
    const errors: RowError[] = [];
    const currencyColumn = mapping.currency;
    for (const raw of rawRows) {
      const invoiceNumber = readCell(raw, mapping, 'invoiceNumber');
      const invoiceDateRaw = readCell(raw, mapping, 'invoiceDate');
      const taxableRaw = readCell(raw, mapping, 'taxableAmount');
      const vatRaw = readCell(raw, mapping, 'vatAmount');
      const totalRaw = readCell(raw, mapping, 'totalAmount');
      const supplierVatin = readCell(raw, mapping, 'supplierVatin') || undefined;
      const buyerVatin = readCell(raw, mapping, 'buyerVatin') || undefined;
      const supplierName = readCell(raw, mapping, 'supplierName') || undefined;
      const buyerName = readCell(raw, mapping, 'buyerName') || undefined;
      const description = readCell(raw, mapping, 'description') || undefined;
      const currency =
        (currencyColumn ? raw.cells[currencyColumn] : undefined)?.toString().trim() || 'OMR';

      if (!invoiceNumber) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'invoiceNumber',
          message: `row ${raw.sourceRowNo}: missing invoice number`,
        });
        continue;
      }
      const invoiceDate = parseDate(invoiceDateRaw);
      if (!invoiceDate) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'invoiceDate',
          rawValue: invoiceDateRaw,
          message: `row ${raw.sourceRowNo}: invalid or missing invoice date: ${invoiceDateRaw || '(empty)'}`,
        });
        continue;
      }
      if (!supplierVatin && !buyerVatin) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'vatin',
          message: `row ${raw.sourceRowNo}: missing VATIN`,
        });
        continue;
      }
      const taxable = parseAmount(taxableRaw);
      const vat = parseAmount(vatRaw);
      const total = parseAmount(totalRaw);
      if (taxable === null) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'taxableAmount',
          rawValue: taxableRaw,
          message: `row ${raw.sourceRowNo}: missing or invalid taxable amount`,
        });
        continue;
      }
      if (vat === null) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'vatAmount',
          rawValue: vatRaw,
          message: `row ${raw.sourceRowNo}: missing or invalid VAT amount`,
        });
        continue;
      }
      if (total === null) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'totalAmount',
          rawValue: totalRaw,
          message: `row ${raw.sourceRowNo}: missing or invalid total amount`,
        });
        continue;
      }
      const expected = taxable + vat;
      if (Math.abs(expected - total) > VAT_RECONCILE_TOLERANCE) {
        errors.push({
          sourceRowNo: raw.sourceRowNo,
          field: 'totalAmount',
          rawValue: totalRaw,
          message:
            `row ${raw.sourceRowNo}: VAT math mismatch ` +
            `(taxable=${taxable.toFixed(3)} vat=${vat.toFixed(3)} total=${total.toFixed(3)} ` +
            `expected ${expected.toFixed(3)})`,
        });
        continue;
      }
      rows.push({
        sourceRowNo: raw.sourceRowNo,
        invoiceNumber,
        invoiceDate,
        supplierName,
        supplierVatin,
        buyerName,
        buyerVatin,
        currency,
        taxableAmount: taxable,
        vatAmount: vat,
        totalAmount: total,
        description,
      });
    }
    return { rows, errors };
  }
}
