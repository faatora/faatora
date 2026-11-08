import {
  REQUIRED_HEADER_COLUMNS,
  type ParseError,
  type ParseResult,
  type ParsedRow,
} from './types';

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ',') {
        out.push(current);
        current = '';
      } else if (ch === '"' && current.length === 0) {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  out.push(current);
  return out.map((s) => s.trim());
}

function splitLines(text: string): string[] {
  // Split on \n but respect quoted strings that span lines (unusual but possible).
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export async function parseCsv(buffer: Buffer): Promise<ParseResult> {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const rawLines = splitLines(text).filter((l) => l.trim().length > 0);
  const errors: ParseError[] = [];
  const rows: ParsedRow[] = [];
  if (rawLines.length === 0) {
    errors.push({ rowNo: 0, message: 'CSV is empty' });
    return { rows, errors };
  }
  const headers = splitCsvLine(rawLines[0]).map((h) => h.toLowerCase());
  const missing = REQUIRED_HEADER_COLUMNS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    errors.push({
      rowNo: 1,
      message: `Missing required header column(s): ${missing.join(', ')}`,
    });
    return { rows, errors };
  }
  const idx = (name: string): number => headers.indexOf(name);
  for (let i = 1; i < rawLines.length; i++) {
    const rowNo = i + 1; // 1-based header is row 1, so data rows start at 2
    const cells = splitCsvLine(rawLines[i]);
    if (cells.every((c) => c === '')) continue;
    const get = (name: string): string => (cells[idx(name)] ?? '').trim();
    const numberVal = get('number');
    const issueDate = get('issue_date');
    const supplierName = get('supplier_name');
    const buyerName = get('buyer_name');
    const lineDescription = get('line_description');
    const quantityRaw = get('line_quantity');
    const unitPriceRaw = get('line_unit_price');
    const vatRateRaw = get('line_vat_rate');
    const vatCategory = get('line_vat_category') || 'S';
    if (!numberVal) {
      errors.push({
        rowNo,
        columnName: 'number',
        rawValue: numberVal,
        message: 'number is required',
      });
      continue;
    }
    if (!issueDate) {
      errors.push({
        rowNo,
        columnName: 'issue_date',
        rawValue: issueDate,
        message: 'issue_date is required',
      });
      continue;
    }
    if (!supplierName) {
      errors.push({
        rowNo,
        columnName: 'supplier_name',
        rawValue: supplierName,
        message: 'supplier_name is required',
      });
      continue;
    }
    if (!buyerName) {
      errors.push({
        rowNo,
        columnName: 'buyer_name',
        rawValue: buyerName,
        message: 'buyer_name is required',
      });
      continue;
    }
    if (!lineDescription) {
      errors.push({
        rowNo,
        columnName: 'line_description',
        rawValue: lineDescription,
        message: 'line_description is required',
      });
      continue;
    }
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({
        rowNo,
        columnName: 'line_quantity',
        rawValue: quantityRaw,
        message: `invalid line_quantity: ${quantityRaw}`,
      });
      continue;
    }
    const unitPrice = Number(unitPriceRaw);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push({
        rowNo,
        columnName: 'line_unit_price',
        rawValue: unitPriceRaw,
        message: `invalid line_unit_price: ${unitPriceRaw}`,
      });
      continue;
    }
    const vatRate = vatRateRaw === '' ? 5 : Number(vatRateRaw);
    if (!Number.isFinite(vatRate) || vatRate < 0) {
      errors.push({
        rowNo,
        columnName: 'line_vat_rate',
        rawValue: vatRateRaw,
        message: `invalid line_vat_rate: ${vatRateRaw}`,
      });
      continue;
    }
    rows.push({
      rowNo,
      number: numberVal,
      issueDate,
      supplierVatin: get('supplier_vatin') || undefined,
      supplierName,
      buyerVatin: get('buyer_vatin') || undefined,
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
