/**
 * Types for the Fawtara PDF/A-3 renderer.
 *
 * These are the INPUT shapes the renderer consumes. They are deliberately
 * separate from the canonical/semantic invoice model so that the renderer
 * stays decoupled from upstream regime mapping:
 *
 *  - Callers pre-format all monetary values as strings (grandTotal,
 *    vatTotal, lineAmount, ...). This keeps the renderer out of the
 *    rounding/precision business, which is handled by the semantic
 *    layer (see src/semantic/en16931.ts).
 *  - The embedded UBL XML is passed in as a UTF-8 byte buffer. The
 *    renderer does not re-serialise; the caller owns canonicalisation
 *    because the UBL bytes may already be hashed/signed.
 *  - Bilingual party/line fields are optional: when an Arabic variant is
 *    missing the LTR (English) value is reused in both columns.
 */

/** Bilingual string pair. `ar` is optional; fall back to `en` when absent. */
export interface BilingualText {
  en: string;
  ar?: string;
}

/** A party (seller or buyer) on the rendered invoice. */
export interface InvoicePartyRender {
  /** Legal name. Bilingual so the LTR and RTL columns can both show it. */
  name: BilingualText;
  /** VAT identification number including country prefix. */
  vatNumber?: string;
  /** Free-form address block, newline-separated. */
  address?: BilingualText;
  /** Country, ISO 3166-1 alpha-2 or human name — rendered as-is. */
  country?: string;
}

/** One line item on the rendered invoice. */
export interface InvoiceLineRender {
  lineNo: number;
  description: BilingualText;
  /** Decimal quantity formatted for display (e.g. "2", "1.500"). */
  quantity: string;
  /** Unit of measure code or label (e.g. "C62", "KGM"). */
  unitCode: string;
  /** Unit price, display-formatted (e.g. "10.000"). */
  unitPrice: string;
  /** Line net amount (quantity * unitPrice), display-formatted. */
  lineAmount: string;
  /** VAT rate as a percentage, display-formatted (e.g. "5", "0"). */
  vatRate: string;
}

/** Document-level totals, all display-formatted. */
export interface InvoiceTotalsRender {
  /** Sum of line net amounts. */
  netTotal: string;
  /** Sum of VAT amounts across all categories. */
  vatTotal: string;
  /** Grand total payable (= netTotal + vatTotal). */
  grandTotal: string;
}

/** Firm branding carried onto the rendered invoice. */
export interface FirmBranding {
  /** Trading name displayed in the header. */
  firmName: BilingualText;
  /**
   * Absolute path to the firm's logo file on disk (PNG/JPEG/SVG).
   * The renderer reads it and inlines it as a data URI so the PDF
   * is self-contained. A per-firm uploaded logo is plugged in here.
   * When absent, the header falls back to text-only branding.
   */
  logoPath?: string;
  /** Primary brand colour, any CSS colour string. Default: "#0F172A". */
  primaryColor?: string;
}

/**
 * Everything the renderer needs to produce a PDF/A-3 invoice.
 *
 * `embeddedXml` is the UBL 2.1 XML that will be attached as a PDF
 * embedded file (ZUGFeRD / Factur-X pattern). The caller provides
 * both the bytes and the filename so the signing layer can keep
 * byte-for-byte control over what's embedded.
 */
export interface InvoiceRenderInput {
  /** Document number (BT-1). Displayed and used in file names. */
  invoiceNumber: string;
  /** ISO 8601 issue date (YYYY-MM-DD). */
  issueDate: string;
  /** ISO 8601 issue timestamp for the QR (RFC 3339). */
  issueTimestamp: string;
  /** ISO 4217 currency code, e.g. "OMR". */
  currency: string;
  /** Document kind — drives the header label. */
  documentType: 'invoice' | 'credit_note' | 'debit_note';
  seller: InvoicePartyRender;
  buyer: InvoicePartyRender;
  lines: InvoiceLineRender[];
  totals: InvoiceTotalsRender;
  /** Optional free-text note rendered at the bottom of the invoice. */
  notes?: BilingualText;
  /** Firm branding (name, logo, colour). */
  branding: FirmBranding;
  /** UBL 2.1 XML bytes to embed as a PDF/A-3 attachment. */
  embeddedXml: Uint8Array;
  /** Suggested filename for the embedded XML attachment. */
  embeddedXmlName: string;
}

/** Output of the render step. */
export interface InvoiceRenderOutput {
  /** The rendered PDF bytes. */
  pdfBytes: Uint8Array;
  /** The filename under which the UBL XML was embedded. */
  embeddedXmlName: string;
  /**
   * Whether the PDF was successfully flagged as PDF/A-3 conformant.
   *
   * At EP4, pdf-lib is not a full PDF/A conformance producer: it can
   * attach the XML using /AFRelationship and add basic metadata, but
   * ICC profile embedding, XMP packet enrichment and OutputIntent
   * validation still require a downstream veraPDF step. The flag is
   * therefore `false` at the moment — see `pdf/README.md`.
   */
  pdfA3Conformant: boolean;
}
