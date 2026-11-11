/**
 * UBL 2.1 CreditNote-2 serialiser for PINT-OM.
 *
 * Mirrors `serializer.ts` (Invoice) but emits the dedicated UBL
 * `<CreditNote>` document under the `urn:oasis:names:specification:ubl:
 * schema:xsd:CreditNote-2` namespace, as required by Peppol BIS Billing
 * 3.0 and the OTA Peppol document-type identifier:
 *
 *   urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2
 *     ::CreditNote
 *     ##urn:cen.eu:en16931:2017#compliant#
 *       urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1
 *
 * Shape differences from Invoice that this serialiser handles:
 *  - Root element is `<CreditNote>` (no `<Invoice>`).
 *  - The type-code element is `<cbc:CreditNoteTypeCode>` (not
 *    `<cbc:InvoiceTypeCode>`). Peppol-permitted code is 381.
 *  - A `<cac:BillingReference>` wrapping an
 *    `<cac:InvoiceDocumentReference>` is REQUIRED on a credit note:
 *    every credit note must reference the original invoice it
 *    reduces, which is also an Oman VAT-law requirement.
 *  - Line container is `<cac:CreditNoteLine>` with child
 *    `<cbc:CreditedQuantity>` (instead of InvoicedQuantity).
 *
 * Determinism: same contract as the Invoice serialiser — string-key
 * insertion order is preserved through fast-xml-parser's XMLBuilder and
 * every monetary amount is rendered via `toFixed(scale)` so the bytes
 * are stable across re-runs. The signing layer hashes this output.
 */

import { XMLBuilder } from 'fast-xml-parser';
import type { PintOmInvoice, PintOmParty } from '../pint-om/types.js';
import type { SemanticLine, SemanticVatBreakdownRow } from '../semantic/en16931.js';

/* -------------------------------------------------------------------------- */
/* Public input shape                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reference to the invoice that this credit note reduces.
 *
 * UBL `cac:BillingReference/cac:InvoiceDocumentReference` carries the
 * original invoice number (BT-25) and optionally its issue date
 * (BT-26). Peppol BIS Billing 3.0 requires that at least the number
 * be present when the credit note references a single invoice.
 */
export interface CreditNoteBillingReference {
  invoiceDocumentReference: {
    /** BT-25: original invoice number. */
    id: string;
    /** BT-26: original invoice issue date (ISO YYYY-MM-DD). Optional. */
    issueDate?: string;
  };
}

/**
 * CreditNote serialiser input.
 *
 * Carries every field a PINT-OM invoice carries (customizationId /
 * profileId, parties, lines, totals) plus the mandatory
 * billingReference back to the original invoice. The `type` discriminator
 * on the semantic layer is already `credit_note` (BT-3 = 381), so no
 * separate field is needed here.
 */
export interface CreditNoteInput extends PintOmInvoice {
  billingReference: CreditNoteBillingReference;
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (duplicated from serializer.ts to keep the two files    */
/* independently auditable; the bytes they emit must agree on OMR/USD scales) */
/* -------------------------------------------------------------------------- */

function amountScale(currency: string): number {
  return currency === 'OMR' ? 3 : 2;
}

function fmtAmount(value: number, currency: string): string {
  return value.toFixed(amountScale(currency));
}

function money(value: number, currency: string): Record<string, unknown> {
  return {
    '@_currencyID': currency,
    '#text': fmtAmount(value, currency),
  };
}

function fmtPercent(rate: number): string {
  return String(rate);
}

/* -------------------------------------------------------------------------- */
/* Subtree builders                                                           */
/* -------------------------------------------------------------------------- */

function buildPartyBlock(p: PintOmParty): Record<string, unknown> {
  const party: Record<string, unknown> = {
    'cac:PartyName': { 'cbc:Name': p.bt27_name },
  };
  if (p.bt31_vatIdentifier) {
    party['cac:PartyTaxScheme'] = {
      'cbc:CompanyID': p.bt31_vatIdentifier,
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    };
  }
  return { 'cac:Party': party };
}

function buildTaxSubtotal(row: SemanticVatBreakdownRow, currency: string): Record<string, unknown> {
  return {
    'cbc:TaxableAmount': money(row.bt116_categoryTaxableAmount, currency),
    'cbc:TaxAmount': money(row.bt117_categoryTaxAmount, currency),
    'cac:TaxCategory': {
      'cbc:ID': row.bt118_categoryCode,
      'cbc:Percent': fmtPercent(row.bt119_categoryRate),
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    },
  };
}

/**
 * Credit-note line. The element names differ from InvoiceLine:
 *   - `cbc:InvoicedQuantity` -> `cbc:CreditedQuantity`
 *   - everything else is identical to the invoice line shape.
 */
function buildCreditNoteLine(line: SemanticLine, currency: string): Record<string, unknown> {
  return {
    'cbc:ID': line.bt126_lineId,
    'cbc:CreditedQuantity': {
      '@_unitCode': line.bt130_unitCode,
      '#text': String(line.bt129_quantity),
    },
    'cbc:LineExtensionAmount': money(line.bt131_lineNetAmount, currency),
    'cac:Item': { 'cbc:Name': line.bt146_itemName },
    'cac:Price': {
      'cbc:PriceAmount': money(line.bt146_itemNetPrice, currency),
    },
    'cac:TaxCategory': {
      'cbc:ID': line.bt152_itemVatCategoryCode,
      'cbc:Percent': fmtPercent(line.bt153_itemVatRate),
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const UBL_NS_CREDIT_NOTE = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';
const UBL_NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const UBL_NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

/**
 * Serialise a PINT-OM credit note to UBL CreditNote-2 XML.
 *
 * The caller is expected to hand in semantic totals that already carry
 * the reversal sign — this function does not negate anything; it only
 * formats. The service layer that builds the input is responsible for
 * computing the (negative or positive) amounts per Oman VAT-law intent.
 * Peppol convention is for credit-note amounts to appear as positive
 * values with the "credit" nature carried by the document type code,
 * and that is the convention Faatora follows.
 */
export function serializeCreditNote(input: CreditNoteInput): string {
  const currency = input.bt5_currencyCode;

  const root: Record<string, unknown> = {
    '@_xmlns': UBL_NS_CREDIT_NOTE,
    '@_xmlns:cac': UBL_NS_CAC,
    '@_xmlns:cbc': UBL_NS_CBC,
    'cbc:CustomizationID': input.customizationId,
    'cbc:ProfileID': input.profileId,
    'cbc:ID': input.bt1_invoiceNumber,
  };

  if (input.documentUuid) {
    root['cbc:UUID'] = input.documentUuid;
  }

  root['cbc:IssueDate'] = input.bt2_issueDate;
  // UBL CreditNote-2 uses CreditNoteTypeCode (not InvoiceTypeCode).
  // The semantic layer already maps canonical 'credit_note' -> 381.
  root['cbc:CreditNoteTypeCode'] = input.bt3_typeCode;
  root['cbc:DocumentCurrencyCode'] = input.bt5_currencyCode;

  // BT-25 / BT-26: reference to the original invoice. Required.
  const billingRef: Record<string, unknown> = {
    'cbc:ID': input.billingReference.invoiceDocumentReference.id,
  };
  if (input.billingReference.invoiceDocumentReference.issueDate) {
    billingRef['cbc:IssueDate'] = input.billingReference.invoiceDocumentReference.issueDate;
  }
  root['cac:BillingReference'] = {
    'cac:InvoiceDocumentReference': billingRef,
  };

  root['cac:AccountingSupplierParty'] = buildPartyBlock(input.supplier);
  root['cac:AccountingCustomerParty'] = buildPartyBlock(input.buyer);
  root['cac:TaxTotal'] = {
    'cbc:TaxAmount': money(input.bg22_documentTotals.bt110_totalVatAmount, currency),
    'cac:TaxSubtotal': input.bg23_vatBreakdown.map((row) => buildTaxSubtotal(row, currency)),
  };
  root['cac:LegalMonetaryTotal'] = {
    'cbc:LineExtensionAmount': money(input.bg22_documentTotals.bt106_sumOfLineNetAmounts, currency),
    'cbc:TaxExclusiveAmount': money(
      input.bg22_documentTotals.bt109_totalAmountWithoutVat,
      currency,
    ),
    'cbc:TaxInclusiveAmount': money(input.bg22_documentTotals.bt112_totalAmountWithVat, currency),
    'cbc:PayableAmount': money(input.bg22_documentTotals.bt115_amountDueForPayment, currency),
  };
  root['cac:CreditNoteLine'] = input.bg25_lines.map((line) => buildCreditNoteLine(line, currency));

  const builder = new XMLBuilder({
    attributeNamePrefix: '@_',
    ignoreAttributes: false,
    textNodeName: '#text',
    format: true,
    indentBy: '  ',
    processEntities: true,
    suppressEmptyNode: false,
  });

  const body = builder.build({ CreditNote: root }) as string;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
}
