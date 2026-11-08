// W2-D — shared TypeScript types for the imports feature.
//
// Mirrors the /firms/:id/imports endpoint contracts in
// apps/api/src/modules/imports/firm-imports.controller.ts.

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

export interface ParsedImportRow {
  sourceRowNo: number;
  invoiceNumber: string;
  invoiceDate: string;
  supplierName?: string;
  supplierVatin?: string;
  buyerName?: string;
  buyerVatin?: string;
  currency: string;
  taxableAmount: number;
  vatAmount: number;
  totalAmount: number;
  description?: string;
  vatRate?: number;
}

export interface PreviewRow extends ParsedImportRow {
  rowHash: string;
  duplicate: boolean;
}

export interface RowError {
  sourceRowNo: number;
  field?: string;
  rawValue?: string;
  message: string;
}

export interface PreviewSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
}

export type ColumnMapping = Record<string, string | undefined>;

export interface PreviewResponse {
  previewToken: string;
  rows: PreviewRow[];
  errors: RowError[];
  headers: string[];
  mapping: ColumnMapping;
  summary: PreviewSummary;
}

export interface CommitResponse {
  batchId: string;
  rowCountTotal: number;
  rowCountCommitted: number;
  rowCountSkipped: number;
  rowCountErrored: number;
}
