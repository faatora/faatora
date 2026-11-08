export interface ParsedRow {
  rowNo: number;
  number: string;
  issueDate: string;
  supplierVatin?: string;
  supplierName: string;
  buyerVatin?: string;
  buyerName: string;
  lineDescription: string;
  lineQuantity: number;
  lineUnitPrice: number;
  lineVatRate: number;
  lineVatCategory: string;
}

export interface ParseError {
  rowNo: number;
  columnName?: string;
  rawValue?: string;
  message: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: ParseError[];
}

export const REQUIRED_HEADER_COLUMNS = [
  'number',
  'issue_date',
  'supplier_vatin',
  'supplier_name',
  'buyer_vatin',
  'buyer_name',
  'line_description',
  'line_quantity',
  'line_unit_price',
  'line_vat_rate',
  'line_vat_category',
];
