/**
 * Shared types for the credit note / debit note UI.
 *
 * Shapes mirror @faatora/api's response bodies. We duplicate them
 * here rather than import from the API package so the web bundle
 * stays decoupled from the Nest runtime.
 */

export type TaxDocumentKind = 'credit_note' | 'debit_note';

export interface CreateTaxDocumentLineInput {
  description: string;
  quantity: number;
  unitCode?: string;
  unitPrice: number;
  vatCategory?: string;
  vatRate?: number;
  originalInvoiceLineId?: string;
}

export interface CreateTaxDocumentInput {
  number: string;
  issueDate: string;
  originalInvoiceId: string;
  currency?: string;
  reason?: string;
  notes?: string;
  lines: CreateTaxDocumentLineInput[];
}

export interface TaxDocumentLine {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatCategory: string;
  vatRate: string;
  lineNet: string;
}

export interface TaxDocumentResult {
  id: string;
  kind: TaxDocumentKind;
  number: string;
  originalInvoiceId: string;
  status: string;
  currency: string;
  subtotal: string;
  vatTotal: string;
  grandTotal: string;
  ublXml: string;
  rulePackVersion: string;
  lines: TaxDocumentLine[];
}

/**
 * Minimal shape of an invoice line we hand to the form so the user
 * can tick items to credit / debit. Only the display-necessary
 * fields are carried; the server already holds the full detail.
 */
export interface OriginalInvoiceLine {
  id: string;
  lineNo: number;
  description: string;
  quantity: number;
  unitCode: string;
  unitPrice: number;
  vatCategory: string;
  vatRate: number;
}

export interface OriginalInvoice {
  id: string;
  number: string;
  issueDate: string;
  status: string;
  currency: string;
  lines: OriginalInvoiceLine[];
}
