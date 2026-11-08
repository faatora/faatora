/**
 * W2-D — Tally Prime CSV parser.
 *
 * Accepts two Tally Prime CSV exports:
 *
 *   1. Day Book layout, columns:
 *        Date, Voucher Type, Voucher No., Debit Ledger, Credit Ledger,
 *        Debit Amount, Credit Amount, Narration
 *      Day Book is journal-entry data: each voucher is typically split
 *      across multiple rows (customer debit, sales credit, VAT credit).
 *      We group by `Voucher No.`, sum credits to derive totalAmount,
 *      detect a VAT ledger (name containing "VAT") to split vatAmount
 *      from taxableAmount, and infer buyer/supplier from the ledgers.
 *
 *   2. Sales Register layout, columns:
 *        Date, Voucher Type, Voucher No., Party Ledger, Party VATIN,
 *        Taxable Amount, VAT Amount, Total Amount
 *      Sales Register is one row per invoice with VAT already broken
 *      out. This is the clean path and no grouping is needed.
 *
 * Both layouts land in the same RawRow[] shape, keyed by the header
 * names from the source file. The column-mapping service (default or
 * firm override) then maps those header names onto the canonical
 * ParsedImportRow fields. For Day Book, grouping happens before
 * handing the raw rows to the mapper — we emit one synthetic raw row
 * per voucher with aggregated amounts.
 */

import Papa from 'papaparse';
import type { RawParseResult, RawRow, RowError } from './parsed-import-row';

interface DayBookLine {
  date: string;
  voucherType: string;
  voucherNo: string;
  debitLedger: string;
  creditLedger: string;
  debitAmount: number;
  creditAmount: number;
  narration: string;
  sourceRowNo: number;
}

const DAY_BOOK_HEADERS = [
  'Date',
  'Voucher Type',
  'Voucher No.',
  'Debit Ledger',
  'Credit Ledger',
  'Debit Amount',
  'Credit Amount',
  'Narration',
];

const SALES_REGISTER_HEADERS = [
  'Date',
  'Voucher Type',
  'Voucher No.',
  'Party Ledger',
  'Party VATIN',
  'Taxable Amount',
  'VAT Amount',
  'Total Amount',
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

/** Detect which Tally layout was exported by comparing the header set. */
function detectLayout(headers: string[]): 'daybook' | 'sales_register' | 'unknown' {
  const set = new Set(headers);
  const hasAll = (needed: string[]): boolean => needed.every((h) => set.has(h));
  if (hasAll(SALES_REGISTER_HEADERS)) return 'sales_register';
  if (hasAll(DAY_BOOK_HEADERS)) return 'daybook';
  return 'unknown';
}

function groupDayBookByVoucher(lines: DayBookLine[]): RawRow[] {
  const groups = new Map<string, DayBookLine[]>();
  for (const line of lines) {
    if (!line.voucherNo) continue;
    const key = line.voucherNo;
    const existing = groups.get(key);
    if (existing) existing.push(line);
    else groups.set(key, [line]);
  }
  const out: RawRow[] = [];
  for (const [voucherNo, voucherLines] of groups.entries()) {
    const first = voucherLines[0];
    let vatAmount = 0;
    let taxableAmount = 0;
    let totalAmount = 0;
    let partyLedger = '';
    for (const l of voucherLines) {
      // In a Tally sales entry: customer ledger is debited (debit amount
      // = gross receivable), sales + VAT ledgers are credited.
      if (/vat|tax/i.test(l.creditLedger)) {
        vatAmount += l.creditAmount;
      } else if (l.creditAmount > 0) {
        taxableAmount += l.creditAmount;
      }
      if (l.debitAmount > 0) {
        totalAmount += l.debitAmount;
        // Prefer a non-tax ledger on the debit side as the party.
        if (!/vat|tax/i.test(l.debitLedger) && l.debitLedger) {
          partyLedger = l.debitLedger;
        }
      }
    }
    // If credit-side totals are missing the VAT split, fall back to the
    // raw total so downstream validation surfaces a math mismatch error
    // instead of an opaque zero.
    if (taxableAmount === 0 && vatAmount === 0) {
      taxableAmount = totalAmount;
    }
    out.push({
      sourceRowNo: first.sourceRowNo,
      cells: {
        Date: first.date,
        'Voucher Type': first.voucherType,
        'Voucher No.': voucherNo,
        'Party Ledger': partyLedger,
        'Party VATIN': '',
        'Taxable Amount': taxableAmount.toFixed(3),
        'VAT Amount': vatAmount.toFixed(3),
        'Total Amount': totalAmount.toFixed(3),
        Narration: first.narration,
      },
    });
  }
  return out;
}

export async function parseTallyCsv(buffer: Buffer): Promise<RawParseResult> {
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
      // papaparse row numbers are 0-based on data; add 2 for 1-based header row.
      const rowNo = typeof e.row === 'number' ? e.row + 2 : 0;
      errors.push({ sourceRowNo: rowNo, message: `CSV parse: ${e.message}` });
    }
  }
  const headers = (parsed.meta.fields ?? []).map(normalizeHeader);
  const layout = detectLayout(headers);
  if (layout === 'unknown') {
    errors.push({
      sourceRowNo: 1,
      message:
        'Unrecognized Tally CSV layout. Expected Day Book or Sales Register columns. Found: ' +
        headers.join(', '),
    });
    return { rawRows: [], headers, errors };
  }

  const dataRows = parsed.data ?? [];
  if (layout === 'sales_register') {
    const rawRows: RawRow[] = dataRows.map((row, i) => {
      const cells: Record<string, string> = {};
      for (const h of headers) {
        cells[h] = (row[h] ?? '').toString().trim();
      }
      return { sourceRowNo: i + 2, cells };
    });
    return { rawRows, headers, errors };
  }

  // Day Book: build line structs, then group by voucher.
  const lines: DayBookLine[] = dataRows.map((row, i) => ({
    date: (row['Date'] ?? '').toString().trim(),
    voucherType: (row['Voucher Type'] ?? '').toString().trim(),
    voucherNo: (row['Voucher No.'] ?? '').toString().trim(),
    debitLedger: (row['Debit Ledger'] ?? '').toString().trim(),
    creditLedger: (row['Credit Ledger'] ?? '').toString().trim(),
    debitAmount: toNumber(row['Debit Amount']),
    creditAmount: toNumber(row['Credit Amount']),
    narration: (row['Narration'] ?? '').toString().trim(),
    sourceRowNo: i + 2,
  }));
  const grouped = groupDayBookByVoucher(lines);
  // Normalize headers to the sales-register vocabulary so mapping sees
  // one consistent set of source column names for Tally.
  return { rawRows: grouped, headers: SALES_REGISTER_HEADERS, errors };
}

export const TALLY_SALES_REGISTER_HEADERS = SALES_REGISTER_HEADERS;
export const TALLY_DAY_BOOK_HEADERS = DAY_BOOK_HEADERS;
