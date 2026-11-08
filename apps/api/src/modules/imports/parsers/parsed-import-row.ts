/**
 * EP5 Wave 2 (W2-D) — canonical row shape every import parser normalizes to.
 *
 * ParsedImportRow is the common contract for the three new parsers (Tally
 * CSV in Day Book or Sales Register layout, Tally XML, Zoho Books CSV).
 * The column-mapping service transforms raw header-keyed rows into this
 * shape before VAT math and required-field validation runs.
 *
 * Numbers are carried as plain JS numbers at this stage; the service tier
 * converts to the fixed 3-decimal strings when persisting invoices.
 */

export type ImportSourceFormat =
  | 'tally_daybook_csv'
  | 'tally_sales_register_csv'
  | 'tally_xml'
  | 'zoho_books_csv';

export const IMPORT_SOURCE_FORMATS: ImportSourceFormat[] = [
  'tally_daybook_csv',
  'tally_sales_register_csv',
  'tally_xml',
  'zoho_books_csv',
];

export function isImportSourceFormat(x: unknown): x is ImportSourceFormat {
  return typeof x === 'string' && (IMPORT_SOURCE_FORMATS as string[]).includes(x);
}

export interface ParsedImportRow {
  /** 1-based row number in the source file (the header row is 1). */
  sourceRowNo: number;
  invoiceNumber: string;
  /** ISO-8601 YYYY-MM-DD. */
  invoiceDate: string;
  supplierName?: string;
  supplierVatin?: string;
  buyerName?: string;
  buyerVatin?: string;
  currency: string;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
  /** Optional free-text description for the single-line invoice. */
  description?: string;
  /** Optional VAT rate as a percentage (e.g. 5 for 5%). */
  vatRate?: number;
}

export interface RowError {
  sourceRowNo: number;
  field?: string;
  rawValue?: string;
  message: string;
}

export interface ParsedImportResult {
  rows: ParsedImportRow[];
  errors: RowError[];
}

/**
 * The raw, pre-normalization row the parser hands back per source line.
 * Keys are the source-file column headers (or XML paths), values are the
 * cell contents as strings. The column-mapping service reads these using
 * a mapping that identifies which source column holds each canonical
 * field.
 */
export interface RawRow {
  sourceRowNo: number;
  cells: Record<string, string>;
}

export interface RawParseResult {
  rawRows: RawRow[];
  /** Headers in the order they appeared, for mapping-editor UX. */
  headers: string[];
  /** Structural errors (missing header, malformed XML). Row-level validation
   *  happens after mapping is applied. */
  errors: RowError[];
}
