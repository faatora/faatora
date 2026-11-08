/**
 * W2-D — Tally Prime XML voucher export parser.
 *
 * Normalizes to RawRow[] with the same vocabulary as the Tally Sales
 * Register CSV layout so the mapping layer can treat them uniformly.
 *
 * Tally XML structure (ENVELOPE/BODY/.../VOUCHER) is traversed and each
 * VOUCHER is reduced to a single RawRow. The ledger list inside the
 * voucher is used to split VAT from taxable:
 *   - Any LEDGERENTRY whose LEDGERNAME matches /VAT|TAX/ contributes to
 *     VAT Amount (absolute value of its AMOUNT).
 *   - The remaining non-party ledger entries sum into Taxable Amount.
 *   - The party ledger's AMOUNT (debit for sales) is Total Amount.
 *
 * This produces the same shape the Tally CSV parser does, so the
 * mapping default for format=tally_xml and format=tally_sales_register_csv
 * is identical.
 */

import { XMLParser } from 'fast-xml-parser';
import type { RawParseResult, RawRow, RowError } from './parsed-import-row';
import { TALLY_SALES_REGISTER_HEADERS } from './tally-csv.parser';

interface LedgerEntry {
  LEDGERNAME?: string;
  AMOUNT?: string | number;
  ISPARTYLEDGER?: string;
  ISDEEMEDPOSITIVE?: string;
}

interface Voucher {
  VOUCHERNUMBER?: string | number;
  DATE?: string | number;
  PARTYLEDGERNAME?: string;
  PARTYNAME?: string;
  PARTYGSTIN?: string;
  PARTYVATIN?: string;
  BUYERGSTIN?: string;
  BUYERVATIN?: string;
  VOUCHERTYPENAME?: string;
  NARRATION?: string;
  'LEDGERENTRIES.LIST'?: LedgerEntry | LedgerEntry[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toIsoDate(raw: string | number | undefined): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function toNumber(raw: string | number | undefined): number {
  if (raw == null) return 0;
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function parseTallyXml(buffer: Buffer): Promise<RawParseResult> {
  const text = buffer.toString('utf-8');
  const errors: RowError[] = [];
  if (text.trim().length === 0) {
    errors.push({ sourceRowNo: 0, message: 'XML is empty' });
    return { rawRows: [], headers: [], errors };
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name.endsWith('.LIST'),
  });
  let doc: unknown;
  try {
    doc = parser.parse(text);
  } catch (e) {
    errors.push({ sourceRowNo: 0, message: `XML parse error: ${(e as Error).message}` });
    return { rawRows: [], headers: [], errors };
  }
  const vouchers: Voucher[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'VOUCHER') {
        if (Array.isArray(val)) vouchers.push(...(val as Voucher[]));
        else vouchers.push(val as Voucher);
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(doc);
  if (vouchers.length === 0) {
    errors.push({ sourceRowNo: 0, message: 'No VOUCHER elements found in Tally XML' });
    return { rawRows: [], headers: TALLY_SALES_REGISTER_HEADERS, errors };
  }

  const rawRows: RawRow[] = [];
  let rowIndex = 2;
  for (const v of vouchers) {
    const ledgers = asArray(v['LEDGERENTRIES.LIST']);
    let vatAmount = 0;
    let taxableAmount = 0;
    let totalAmount = 0;
    const partyLedger =
      (v.PARTYLEDGERNAME ?? v.PARTYNAME ?? '').toString().trim() ||
      ledgers.find((l) => l.ISPARTYLEDGER === 'Yes')?.LEDGERNAME ||
      '';
    const partyVatin =
      (v.PARTYVATIN ?? v.PARTYGSTIN ?? v.BUYERVATIN ?? v.BUYERGSTIN ?? '').toString().trim();
    for (const l of ledgers) {
      const ledgerName = (l.LEDGERNAME ?? '').toString();
      const amount = Math.abs(toNumber(l.AMOUNT));
      const isParty = l.ISPARTYLEDGER === 'Yes' || ledgerName === partyLedger;
      if (isParty) {
        totalAmount += amount;
        continue;
      }
      if (/vat|tax/i.test(ledgerName)) {
        vatAmount += amount;
      } else {
        taxableAmount += amount;
      }
    }
    if (totalAmount === 0 && (taxableAmount > 0 || vatAmount > 0)) {
      totalAmount = taxableAmount + vatAmount;
    }
    rawRows.push({
      sourceRowNo: rowIndex++,
      cells: {
        Date: toIsoDate(v.DATE),
        'Voucher Type': (v.VOUCHERTYPENAME ?? '').toString().trim(),
        'Voucher No.': (v.VOUCHERNUMBER ?? '').toString().trim(),
        'Party Ledger': String(partyLedger).trim(),
        'Party VATIN': partyVatin,
        'Taxable Amount': taxableAmount.toFixed(3),
        'VAT Amount': vatAmount.toFixed(3),
        'Total Amount': totalAmount.toFixed(3),
        Narration: (v.NARRATION ?? '').toString().trim(),
      },
    });
  }
  return { rawRows, headers: TALLY_SALES_REGISTER_HEADERS, errors };
}
