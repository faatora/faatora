/**
 * Regime-agnostic canonical invoice model.
 *
 * This is the single input shape every downstream specialization
 * (EN 16931 semantic -> PINT-OM UBL, ZATCA UBL, Peppol BIS, etc.)
 * consumes. It intentionally carries only business meaning that is
 * common across GCC/EU jurisdictions, with no regime-specific fields.
 *
 * Monetary values are plain `number` here; the semantic/serializer
 * layers are responsible for scaled (minor-unit) arithmetic and
 * fixed-precision formatting.
 */

/**
 * High-level document kind. Specializations map these to the
 * jurisdiction's UNTDID 1001 (BT-3) code, e.g. 380 / 381 / 383.
 */
export type InvoiceType = 'invoice' | 'credit_note' | 'debit_note';

/**
 * UNTDID 5305 (Duty/Tax/Fee category code), narrowed to the four
 * categories we support end-to-end.
 *
 * - S: Standard rate
 * - Z: Zero-rated goods
 * - E: Exempt from tax
 * - O: Services outside scope of tax
 */
export type VatCategory = 'S' | 'Z' | 'E' | 'O';

export interface CanonicalAddress {
  street: string;
  city: string;
  postalCode?: string;
  /** ISO 3166-2 subdivision code (e.g. "OM-MA" for Muscat). */
  countrySubdivision?: string;
}

export interface CanonicalParty {
  name: string;
  /** VAT identification number including country prefix where applicable. */
  vatin?: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Peppol participant identifier (scheme::value). */
  peppolId?: string;
  address?: CanonicalAddress;
}

export interface CanonicalLine {
  /** 1-based line sequence number. */
  lineNo: number;
  description: string;
  quantity: number;
  /**
   * UN/ECE Rec 20 unit code. Default meaningful value is "C62" (one),
   * callers should set this explicitly for anything else (KGM, LTR, ...).
   */
  unitCode: string;
  unitPrice: number;
  vatCategory: VatCategory;
  /** VAT rate as a percent (e.g. 5 for 5%, 0 for zero-rated). */
  vatRate: number;
}

/**
 * Optional, server-computed totals. The semantic mapper recomputes
 * these from lines; if present on input they can be used for
 * cross-checks, but they are never trusted as the source of truth.
 */
export interface CanonicalTotals {
  /** Sum of line net amounts (BT-106 equivalent). */
  netTotal: number;
  /** Sum of VAT amounts across all categories (BT-110 equivalent). */
  vatTotal: number;
  /** Grand total payable (BT-112 equivalent). */
  grandTotal: number;
}

export interface CanonicalInvoice {
  /** Stable internal identifier (UUID or similar). */
  id: string;
  type: InvoiceType;
  /** Human-visible invoice/document number. */
  number: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  issueDate: string;
  /** ISO 4217 currency code. */
  currency: string;
  supplier: CanonicalParty;
  buyer: CanonicalParty;
  lines: CanonicalLine[];
  totals?: CanonicalTotals;
  /** Free-form document-level note. */
  notes?: string;
}
