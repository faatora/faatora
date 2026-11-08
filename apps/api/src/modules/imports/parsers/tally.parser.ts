import { XMLParser } from 'fast-xml-parser';
import type { ParseError, ParseResult, ParsedRow } from './types';

interface TallyLedgerEntry {
  LEDGERNAME?: string;
}

interface TallyInventoryEntry {
  STOCKITEMNAME?: string;
  ACTUALQTY?: string | number;
  BILLEDQTY?: string | number;
  RATE?: string | number;
}

interface TallyVoucher {
  VOUCHERNUMBER?: string | number;
  DATE?: string | number;
  PARTYLEDGERNAME?: string;
  PARTYNAME?: string;
  BASICBUYERNAME?: string;
  BUYERGSTIN?: string;
  'ALLINVENTORYENTRIES.LIST'?: TallyInventoryEntry | TallyInventoryEntry[];
  'LEDGERENTRIES.LIST'?: TallyLedgerEntry | TallyLedgerEntry[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseTallyDate(raw: string | number | undefined): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  // Tally dates are typically YYYYMMDD.
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  // Accept already-formatted dates.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function parseRate(raw: string | number | undefined): number {
  if (raw == null) return Number.NaN;
  const s = String(raw).trim();
  // Tally rates look like "10.000/Nos" — strip unit suffix.
  const match = s.match(/^-?\d+(\.\d+)?/);
  if (!match) return Number.NaN;
  return Number(match[0]);
}

function parseQuantity(raw: string | number | undefined): number {
  return parseRate(raw);
}

function extractVatInfo(entries: TallyLedgerEntry[]): { category: string; rate: number } {
  // Default: standard-rated 5%.
  for (const e of entries) {
    const name = (e.LEDGERNAME ?? '').toString();
    const vatMatch = name.match(/VAT\s*@\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (vatMatch) {
      return { category: 'S', rate: Number(vatMatch[1]) };
    }
    if (/zero/i.test(name) && /vat/i.test(name)) return { category: 'Z', rate: 0 };
    if (/exempt/i.test(name) && /vat/i.test(name)) return { category: 'E', rate: 0 };
  }
  return { category: 'S', rate: 5 };
}

export async function parseTallyXml(buffer: Buffer): Promise<ParseResult> {
  const text = buffer.toString('utf-8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name.endsWith('.LIST'),
  });
  const errors: ParseError[] = [];
  const rows: ParsedRow[] = [];
  let doc: unknown;
  try {
    doc = parser.parse(text);
  } catch (e) {
    errors.push({ rowNo: 0, message: `XML parse error: ${(e as Error).message}` });
    return { rows, errors };
  }
  // Walk to find VOUCHER nodes. Tally structure: ENVELOPE/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/VOUCHER.
  const vouchers: TallyVoucher[] = [];
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
        if (Array.isArray(val)) vouchers.push(...(val as TallyVoucher[]));
        else vouchers.push(val as TallyVoucher);
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(doc);
  if (vouchers.length === 0) {
    errors.push({ rowNo: 0, message: 'No VOUCHER elements found in Tally XML' });
    return { rows, errors };
  }
  let rowNo = 1;
  for (const v of vouchers) {
    const numberVal = v.VOUCHERNUMBER == null ? '' : String(v.VOUCHERNUMBER).trim();
    const issueDate = parseTallyDate(v.DATE);
    const buyerName = (v.PARTYLEDGERNAME ?? v.PARTYNAME ?? v.BASICBUYERNAME ?? '')
      .toString()
      .trim();
    const buyerVatin = v.BUYERGSTIN ? String(v.BUYERGSTIN).trim() : undefined;
    const inventory = asArray(v['ALLINVENTORYENTRIES.LIST']);
    const ledger = asArray(v['LEDGERENTRIES.LIST']);
    const vat = extractVatInfo(ledger);
    if (!numberVal) {
      errors.push({
        rowNo: rowNo++,
        columnName: 'VOUCHERNUMBER',
        message: 'VOUCHERNUMBER missing',
      });
      continue;
    }
    if (!issueDate) {
      errors.push({
        rowNo: rowNo++,
        columnName: 'DATE',
        rawValue: String(v.DATE ?? ''),
        message: 'DATE missing or invalid',
      });
      continue;
    }
    if (!buyerName) {
      errors.push({
        rowNo: rowNo++,
        columnName: 'PARTYLEDGERNAME',
        message: 'PARTYLEDGERNAME missing',
      });
      continue;
    }
    if (inventory.length === 0) {
      errors.push({
        rowNo: rowNo++,
        columnName: 'ALLINVENTORYENTRIES.LIST',
        message: 'VOUCHER has no inventory entries',
      });
      continue;
    }
    let hadError = false;
    const voucherRows: ParsedRow[] = [];
    for (const inv of inventory) {
      const thisRow = rowNo++;
      const description = (inv.STOCKITEMNAME ?? '').toString().trim();
      const quantity = parseQuantity(inv.ACTUALQTY ?? inv.BILLEDQTY);
      const unitPrice = parseRate(inv.RATE);
      if (!description) {
        errors.push({
          rowNo: thisRow,
          columnName: 'STOCKITEMNAME',
          message: 'STOCKITEMNAME missing on inventory entry',
        });
        hadError = true;
        continue;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        errors.push({
          rowNo: thisRow,
          columnName: 'ACTUALQTY',
          rawValue: String(inv.ACTUALQTY ?? inv.BILLEDQTY ?? ''),
          message: `invalid quantity: ${inv.ACTUALQTY ?? inv.BILLEDQTY}`,
        });
        hadError = true;
        continue;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        errors.push({
          rowNo: thisRow,
          columnName: 'RATE',
          rawValue: String(inv.RATE ?? ''),
          message: `invalid rate: ${inv.RATE}`,
        });
        hadError = true;
        continue;
      }
      voucherRows.push({
        rowNo: thisRow,
        number: numberVal,
        issueDate,
        supplierVatin: undefined,
        supplierName: '',
        buyerVatin,
        buyerName,
        lineDescription: description,
        lineQuantity: quantity,
        lineUnitPrice: unitPrice,
        lineVatRate: vat.rate,
        lineVatCategory: vat.category,
      });
    }
    if (!hadError) rows.push(...voucherRows);
  }
  return { rows, errors };
}
