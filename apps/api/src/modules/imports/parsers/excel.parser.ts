import ExcelJS from 'exceljs';
import {
  REQUIRED_HEADER_COLUMNS,
  type ParseError,
  type ParseResult,
  type ParsedRow,
} from './types';

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    // Serialize YYYY-MM-DD if date-only.
    const iso = value.toISOString();
    return iso.slice(0, 10);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('text' in obj && typeof obj.text === 'string') return obj.text.trim();
    if ('result' in obj) return cellToString(obj.result);
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? '')
        .join('')
        .trim();
    }
    if ('hyperlink' in obj && typeof obj.hyperlink === 'string') return obj.hyperlink.trim();
  }
  return String(value).trim();
}

function cellToNumber(value: unknown): number {
  if (value == null || value === '') return Number.NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value.trim());
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('result' in obj) return cellToNumber(obj.result);
    if ('text' in obj) return cellToNumber(obj.text);
  }
  return Number.NaN;
}

export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  const errors: ParseError[] = [];
  const rows: ParsedRow[] = [];
  if (!sheet) {
    errors.push({ rowNo: 0, message: 'Excel workbook has no sheets' });
    return { rows, errors };
  }
  const headerRow = sheet.getRow(1);
  const headerMap = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headerMap.set(cellToString(cell.value).toLowerCase(), colNumber);
  });
  const missing = REQUIRED_HEADER_COLUMNS.filter((h) => !headerMap.has(h));
  if (missing.length > 0) {
    errors.push({
      rowNo: 1,
      message: `Missing required header column(s): ${missing.join(', ')}`,
    });
    return { rows, errors };
  }
  const colOf = (name: string): number => headerMap.get(name) ?? 0;
  const lastRow = sheet.actualRowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (!row || row.cellCount === 0) continue;
    const getStr = (name: string): string => cellToString(row.getCell(colOf(name)).value);
    const getNum = (name: string): number => cellToNumber(row.getCell(colOf(name)).value);
    const numberVal = getStr('number');
    const issueDate = getStr('issue_date');
    const supplierName = getStr('supplier_name');
    const buyerName = getStr('buyer_name');
    const lineDescription = getStr('line_description');
    const vatCategory = getStr('line_vat_category') || 'S';
    // Skip rows that look entirely empty.
    if (
      !numberVal &&
      !issueDate &&
      !supplierName &&
      !buyerName &&
      !lineDescription &&
      !row.getCell(colOf('line_quantity')).value
    ) {
      continue;
    }
    if (!numberVal) {
      errors.push({ rowNo: r, columnName: 'number', message: 'number is required' });
      continue;
    }
    if (!issueDate) {
      errors.push({ rowNo: r, columnName: 'issue_date', message: 'issue_date is required' });
      continue;
    }
    if (!supplierName) {
      errors.push({ rowNo: r, columnName: 'supplier_name', message: 'supplier_name is required' });
      continue;
    }
    if (!buyerName) {
      errors.push({ rowNo: r, columnName: 'buyer_name', message: 'buyer_name is required' });
      continue;
    }
    if (!lineDescription) {
      errors.push({
        rowNo: r,
        columnName: 'line_description',
        message: 'line_description is required',
      });
      continue;
    }
    const quantity = getNum('line_quantity');
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({
        rowNo: r,
        columnName: 'line_quantity',
        rawValue: cellToString(row.getCell(colOf('line_quantity')).value),
        message: `invalid line_quantity`,
      });
      continue;
    }
    const unitPrice = getNum('line_unit_price');
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push({
        rowNo: r,
        columnName: 'line_unit_price',
        rawValue: cellToString(row.getCell(colOf('line_unit_price')).value),
        message: `invalid line_unit_price`,
      });
      continue;
    }
    const vatRateRaw = row.getCell(colOf('line_vat_rate')).value;
    const vatRate = vatRateRaw == null || vatRateRaw === '' ? 5 : cellToNumber(vatRateRaw);
    if (!Number.isFinite(vatRate) || vatRate < 0) {
      errors.push({
        rowNo: r,
        columnName: 'line_vat_rate',
        rawValue: cellToString(vatRateRaw),
        message: `invalid line_vat_rate`,
      });
      continue;
    }
    rows.push({
      rowNo: r,
      number: numberVal,
      issueDate,
      supplierVatin: getStr('supplier_vatin') || undefined,
      supplierName,
      buyerVatin: getStr('buyer_vatin') || undefined,
      buyerName,
      lineDescription,
      lineQuantity: quantity,
      lineUnitPrice: unitPrice,
      lineVatRate: vatRate,
      lineVatCategory: vatCategory,
    });
  }
  return { rows, errors };
}
