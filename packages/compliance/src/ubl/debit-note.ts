/**
 * UBL 2.1 Debit Note serialiser for PINT-OM.
 *
 * ## Research — which UBL shape Peppol BIS Billing 3.0 uses
 *
 * UBL 2.1 technically ships a dedicated `DebitNote-2` schema, but
 * **Peppol BIS Billing 3.0** does NOT use it. The BIS 3.0 specification
 * reuses the UBL `Invoice-2` document for debit notes (also called
 * "debit invoices" in the spec) and discriminates by the EN 16931 /
 * UNTDID 1001 type code:
 *
 *   - 380: Commercial invoice
 *   - 381: Credit note (own document kind, UBL `CreditNote-2`)
 *   - 383: Debit note / debit-invoice (UBL `Invoice-2`, type code 383)
 *   - 384: Corrected invoice (UBL `Invoice-2`, type code 384)
 *   - 389: Self-billed invoice (UBL `Invoice-2`, type code 389)
 *
 * References:
 *   - Peppol BIS Billing 3.0 "Invoice", rule BR-01 and the document
 *     identifier set out in the OpenPeppol policy for use of billing
 *     identifiers, which lists only two document ids:
 *       * urn:...:Invoice-2::Invoice##...billing:3.0::2.1  (covers 380, 383, 384, 389, 751)
 *       * urn:...:CreditNote-2::CreditNote##...billing:3.0::2.1
 *     There is no BIS document id that resolves to `DebitNote-2`.
 *   - EN 16931-1:2017 §5.1: the business document "DebitNote" is
 *     represented in UBL syntax as an Invoice carrying BT-3 = 383.
 *   - UBL Peppol BIS 3.0 release notes (PoacC billing 3.0): "debit
 *     notes use the Invoice document; the dedicated UBL DebitNote
 *     document is not used by this BIS."
 *
 * ## Approach
 *
 * We therefore implement debit notes as an **Invoice document with the
 * type code forced to 383**, reusing the existing `pintOmToUbl`
 * serialiser. A debit note that references an original invoice carries
 * the same `cac:BillingReference/cac:InvoiceDocumentReference` block
 * UBL allows on invoices (BT-25 / BT-26).
 *
 * The semantic layer already maps canonical `'debit_note'` to the
 * invoice type code `383`, so this helper's main job is to:
 *   1. make sure the type-code discriminator is 383 even if a caller
 *      hands in a semantic shape with a wrong code (defense in depth),
 *   2. inject the `cac:BillingReference` block, which the plain
 *      Invoice serialiser does not emit.
 *
 * Because `pintOmToUbl` does not take a billingReference argument, we
 * post-process its output here. The injection is textual and tightly
 * scoped: we insert the `<cac:BillingReference>` block immediately
 * after the `<cbc:DocumentCurrencyCode>` element, which is the UBL
 * sequencing position the schema requires. This keeps the Invoice
 * serialiser unchanged (and therefore the determinism / signing-layer
 * contract) while still letting us express the extra element in the
 * right place.
 */

import { pintOmToUbl } from './serializer.js';
import type { PintOmInvoice } from '../pint-om/types.js';

export interface DebitNoteBillingReference {
  invoiceDocumentReference: {
    /** BT-25: original invoice number. Required. */
    id: string;
    /** BT-26: original invoice issue date (ISO YYYY-MM-DD). Optional. */
    issueDate?: string;
  };
}

/**
 * Input for `serializeDebitNote`: identical to a PINT-OM invoice plus
 * the mandatory reference to the original invoice this debit note
 * increases. The semantic layer must already have mapped
 * `bt3_typeCode` to `'383'`; this function enforces that.
 */
export interface DebitNoteInput extends PintOmInvoice {
  billingReference: DebitNoteBillingReference;
}

/**
 * Serialise a PINT-OM debit note to UBL `Invoice-2` XML with
 * InvoiceTypeCode=383 and a `cac:BillingReference` to the original
 * invoice.
 *
 * The amounts are passed through unchanged. Oman VAT law treats a
 * debit note as an increase to the original VAT owed (undercharges,
 * additional charges), so the service layer prepares the semantic
 * invoice with positive amounts representing that increase.
 */
export function serializeDebitNote(input: DebitNoteInput): string {
  if (input.bt3_typeCode !== '383') {
    throw new Error(
      `serializeDebitNote requires bt3_typeCode='383' (got '${input.bt3_typeCode}'). ` +
        'Map the canonical type to "debit_note" at the semantic layer first.',
    );
  }

  const base = pintOmToUbl(input);

  // Build the BillingReference XML fragment. Indented to match the
  // rest of the body (2-space indent under <Invoice>).
  const ref = input.billingReference.invoiceDocumentReference;
  const indent = '  ';
  const refLines = [
    `${indent}<cac:BillingReference>`,
    `${indent}${indent}<cac:InvoiceDocumentReference>`,
    `${indent}${indent}${indent}<cbc:ID>${escapeXmlText(ref.id)}</cbc:ID>`,
  ];
  if (ref.issueDate) {
    refLines.push(
      `${indent}${indent}${indent}<cbc:IssueDate>${escapeXmlText(ref.issueDate)}</cbc:IssueDate>`,
    );
  }
  refLines.push(`${indent}${indent}</cac:InvoiceDocumentReference>`);
  refLines.push(`${indent}</cac:BillingReference>`);
  const refFragment = refLines.join('\n');

  // Insert immediately after the DocumentCurrencyCode element. UBL
  // sequence puts BillingReference between DocumentCurrencyCode (and a
  // few optional elements we do not emit, like OrderReference and
  // ContractDocumentReference) and the party blocks.
  const marker = /<cbc:DocumentCurrencyCode>[^<]*<\/cbc:DocumentCurrencyCode>\n/;
  const match = base.match(marker);
  if (!match) {
    // Should never happen — pintOmToUbl always emits this element.
    // Fail loudly rather than returning malformed XML silently.
    throw new Error(
      'serializeDebitNote: could not find cbc:DocumentCurrencyCode in Invoice-2 output; ' +
        'the Invoice serialiser contract has changed.',
    );
  }
  const insertAt = (match.index ?? 0) + match[0].length;
  return base.slice(0, insertAt) + refFragment + '\n' + base.slice(insertAt);
}

/**
 * Minimal XML text escaper for the BillingReference payload. The
 * invoice number is the only user-controlled value we substitute; it
 * is almost always ASCII, but we still escape defensively so an
 * exotic character cannot break the output.
 */
function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
