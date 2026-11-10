/**
 * W2-D — Zoho Books Invoices CSV parser.
 *
 * Zoho Books exports invoices with one row PER LINE ITEM, so an invoice
 * spanning three products is three rows that share the same Invoice ID.
 *
 * Official columns we read:
 *   Invoice Date, Invoice ID, Customer Name, Customer ID, Item Name,
 *   Quantity, Rate, Discount, Tax Name, Tax %, Total
 *
 * (Zoho optionally also emits CustomerTaxID / GST Treatment / etc.;
 * we read those when present via the mapping layer. Here we only need
 * to produce the raw header-keyed rows and let the mapping transform
 * them.)
 *
 * We group by Invoice ID, sum Quantity*Rate - Discount into taxable,
 * compute VAT as sum of per-line (taxable * tax% / 100), and total
 * as taxable + VAT. Customer VATIN is read from "Customer Tax ID" or
 * "Customer VATIN" when present, else left empty for mapping override.
 */

import Papa from 'papaparse';
import type { RawParseResult, RawRow, RowError } from './parsed-import-row';

const REQUIRED_HEADERS = [
  'Invoice Date',
  'Invoice ID',
  'Customer Name',
  'Item Name',
  'Quantity',
  'Rate',
];

export const ZOHO_BOOKS_CANONICAL_HEADERS = [
  'Invoice Date',
  'Invoice ID',
  'Customer Name',
  'Customer ID',
  'Customer VATIN',
  'Item Name',
  'Quantity',
  'Rate',
  'Discount',
  'Tax Name',
  'Tax %',
  'Taxable Amount',
  'VAT Amount',
  'Total',
];

function normalizeHeader(h: string): string {
  return h.replace(/\uFEFF/g, '').trim();
}

function toNumber(raw: string | undefined): number {
  if (raw == null) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function parseZohoBooksCsv(buffer: Buffer): Promise<RawParseResult> {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const errors: RowError[] = [];
  if (text.trim().length === 0) {
    errors.push({ sourceRowNo: 0, message: 'CSV is empty' });
    return { rawRows: [], headers: [], errors };
  }

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normalizeHeader,
  });
  if (parsed.errors && parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      const rowNo = typeof e.row === 'number' ? e.row + 2 : 0;
      errors.push({ sourceRowNo: rowNo, message: `CSV parse: ${e.message}` });
    }
  }

  const headers = (parsed.meta.fields ?? []).map(normalizeHeader);
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    errors.push({
      sourceRowNo: 1,
      message: 'Missing required Zoho Books column(s): ' + missing.join(', '),
    });
    return { rawRows: [], headers, errors };
  }

  interface Line {
    sourceRowNo: number;
    invoiceId: string;
    invoiceDate: string;
    customerName: string;
    customerId: string;
    customerVatin: string;
    itemName: string;
    quantity: number;
    rate: number;
    discount: number;
    taxName: string;
    taxPercent: number;
    totalFromCsv: number;
  }

  const lines: Line[] = (parsed.data ?? []).map((row, i) => ({
    sourceRowNo: i + 2,
    invoiceId: (row['Invoice ID'] ?? '').toString().trim(),
    invoiceDate: (row['Invoice Date'] ?? '').toString().trim(),
    customerName: (row['Customer Name'] ?? '').toString().trim(),
    customerId: (row['Customer ID'] ?? '').toString().trim(),
    customerVatin: (row['Customer VATIN'] ?? row['Customer Tax ID'] ?? row['CustomerTaxID'] ?? '')
      .toString()
      .trim(),
    itemName: (row['Item Name'] ?? '').toString().trim(),
    quantity: toNumber(row['Quantity']),
    rate: toNumber(row['Rate']),
    discount: toNumber(row['Discount']),
    taxName: (row['Tax Name'] ?? '').toString().trim(),
    taxPercent: toNumber(row['Tax %']),
    totalFromCsv: toNumber(row['Total']),
  }));

  // Group by Invoice ID preserving order of first occurrence.
  const groups = new Map<string, Line[]>();
  const firstOccurrence: string[] = [];
  for (const l of lines) {
    if (!l.invoiceId) continue;
    const existing = groups.get(l.invoiceId);
    if (existing) existing.push(l);
    else {
      groups.set(l.invoiceId, [l]);
      firstOccurrence.push(l.invoiceId);
    }
  }

  const rawRows: RawRow[] = [];
  for (const invoiceId of firstOccurrence) {
    const g = groups.get(invoiceId)!;
    const first = g[0];
    let taxable = 0;
    let vat = 0;
    let totalFromCsv = 0;
    const descriptions: string[] = [];
    let anyTaxPercent = 0;
    for (const l of g) {
      const lineNet = l.quantity * l.rate - l.discount;
      taxable += lineNet;
      vat += (lineNet * l.taxPercent) / 100;
      totalFromCsv += l.totalFromCsv;
      if (l.itemName) descriptions.push(l.itemName);
      if (l.taxPercent > anyTaxPercent) anyTaxPercent = l.taxPercent;
    }
    // Prefer the Zoho-emitted Total column when present — it already
    // carries Zoho's own rounding and matches the printed invoice. Fall
    // back to our computed total otherwise.
    const total = totalFromCsv > 0 ? totalFromCsv : taxable + vat;
    rawRows.push({
      sourceRowNo: first.sourceRowNo,
      cells: {
        'Invoice Date': first.invoiceDate,
        'Invoice ID': first.invoiceId,
        'Customer Name': first.customerName,
        'Customer ID': first.customerId,
        'Customer VATIN': first.customerVatin,
        'Item Name': descriptions.join(' | '),
        Quantity: '1',
        Rate: taxable.toFixed(3),
        Discount: '0',
        'Tax Name': first.taxName,
        'Tax %': anyTaxPercent.toFixed(2),
        'Taxable Amount': taxable.toFixed(3),
        'VAT Amount': vat.toFixed(3),
        Total: total.toFixed(3),
      },
    });
  }

  return { rawRows, headers: ZOHO_BOOKS_CANONICAL_HEADERS, errors };
}
