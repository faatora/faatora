/**
 * EN 16931 semantic invoice representation.
 *
 * Fields are named after their EN 16931 business-term identifiers
 * (`bt1_...`, `bg25_lines`, etc.) so the lineage from canonical ->
 * semantic -> syntax (UBL / CII) is auditable by eye. Any
 * jurisdiction-specific extension (PINT-OM, ZATCA, Peppol BIS) is
 * expected to START from this shape and specialise it — the
 * semantic layer itself stays regime-agnostic.
 *
 * All monetary amounts are decimal numbers quantised to the
 * document currency's minor unit scale (see
 * `codelists/currency.ts`). The semantic layer never performs
 * further rounding; downstream serialisers format for syntax.
 */

/**
 * UNTDID 1001 document type codes we emit.
 * - 380: Commercial invoice
 * - 381: Credit note
 * - 383: Debit note
 */
export type InvoiceTypeCode = '380' | '381' | '383';

export interface SemanticParty {
  /** BT-27 (seller) / BT-44 (buyer): party name. */
  bt27_name: string;
  /** BT-31 (seller) / BT-48 (buyer): VAT identifier. */
  bt31_vatIdentifier?: string;
  /** BT-40 (seller) / BT-55 (buyer): party country code (ISO 3166-1 alpha-2). */
  bt40_countryCode: string;
  /** Optional Peppol participant identifier (used by PINT serialisers). */
  peppolId?: string;
  address?: {
    street: string;
    city: string;
    postalCode?: string;
    countrySubdivision?: string;
  };
}

/**
 * BG-25 invoice line.
 *
 * `bt131_lineNetAmount` is derived (quantity * unitPrice) and
 * written here so downstream syntax layers do not re-derive it.
 */
export interface SemanticLine {
  /** BT-126: line identifier (string form of lineNo). */
  bt126_lineId: string;
  /** BT-127: free-form line note. Undefined when source has none. */
  bt127_lineNote?: string;
  /** BT-129: invoiced quantity. */
  bt129_quantity: number;
  /** BT-130: invoiced quantity unit of measure code (UN/ECE Rec 20). */
  bt130_unitCode: string;
  /** BT-131: line net amount (quantity * item price), currency-quantised. */
  bt131_lineNetAmount: number;
  /** BT-146: item name. */
  bt146_itemName: string;
  /** BT-152: invoiced item VAT category code (UNTDID 5305). */
  bt152_itemVatCategoryCode: string;
  /** BT-153: invoiced item VAT rate (percent). */
  bt153_itemVatRate: number;
  /** BT-146 companion: price-per-unit as billed (used by UBL Price). */
  bt146_itemNetPrice: number;
}

/** BG-23 VAT breakdown row, grouped by category code + rate. */
export interface SemanticVatBreakdownRow {
  /** BT-116: VAT category taxable amount. */
  bt116_categoryTaxableAmount: number;
  /** BT-117: VAT category tax amount. */
  bt117_categoryTaxAmount: number;
  /** BT-118: VAT category code (UNTDID 5305). */
  bt118_categoryCode: string;
  /** BT-119: VAT category rate (percent). */
  bt119_categoryRate: number;
}

/** BG-22 document totals. */
export interface SemanticDocumentTotals {
  /** BT-106: sum of invoice line net amounts. */
  bt106_sumOfLineNetAmounts: number;
  /** BT-109: invoice total amount without VAT (alias of BT-106 when
   *  there are no document-level allowances/charges). */
  bt109_totalAmountWithoutVat: number;
  /** BT-110: total VAT amount. */
  bt110_totalVatAmount: number;
  /** BT-112: invoice total amount with VAT. */
  bt112_totalAmountWithVat: number;
  /** BT-115: amount due for payment. Equals BT-112 at this layer. */
  bt115_amountDueForPayment: number;
}

export interface SemanticInvoice {
  /** BT-1: invoice number (visible to buyer). */
  bt1_invoiceNumber: string;
  /** BT-2: invoice issue date (ISO YYYY-MM-DD). */
  bt2_issueDate: string;
  /** BT-3: invoice type code (UNTDID 1001). */
  bt3_typeCode: InvoiceTypeCode;
  /** BT-5: invoice currency code (ISO 4217). */
  bt5_currencyCode: string;
  /** BT-13: purchase order reference. Undefined when source has none. */
  bt13_purchaseOrderReference?: string;
  /** BT-22: invoice note (document-level). Sourced from canonical.notes. */
  bt22_invoiceNote?: string;
  /** BT-24: UBL customisation / specification identifier version. */
  bt24_specificationVersion: string;

  supplier: SemanticParty;
  buyer: SemanticParty;

  /** BG-25: invoice lines. */
  bg25_lines: SemanticLine[];
  /** BG-23: VAT breakdown rows (one per unique category+rate). */
  bg23_vatBreakdown: SemanticVatBreakdownRow[];
  /** BG-22: document totals. */
  bg22_documentTotals: SemanticDocumentTotals;

  /** Internal id passthrough so downstream can trace back. */
  _canonicalId: string;
}

/** UBL 2.1 is the syntax every regime we target currently uses. */
export const EN16931_UBL_VERSION = '2.1';
