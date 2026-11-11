/**
 * Tests for the UBL Debit Note serialiser.
 *
 * Covers the research claim in debit-note.ts: Peppol BIS Billing 3.0
 * uses Invoice-2 with type code 383 (not the dedicated DebitNote-2
 * schema), plus a cac:BillingReference back to the original invoice.
 */

import {
  canonicalToSemantic,
  parseUbl,
  semanticToPintOm,
  serializeDebitNote,
  type CanonicalInvoice,
  type DebitNoteInput,
} from '../src/index.js';

function baseDebitCanonical(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: '00000000-0000-0000-0000-000000002001',
    type: 'debit_note',
    number: 'DN-UBL-0001',
    issueDate: '2026-10-20',
    currency: 'OMR',
    supplier: {
      name: 'Faatora LLC',
      vatin: 'OM1100000001',
      country: 'OM',
    },
    buyer: {
      name: 'Buyer SAOC',
      vatin: 'OM1100000002',
      country: 'OM',
    },
    lines: [
      {
        lineNo: 1,
        description: 'Undercharge correction',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 5,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
    ...overrides,
  };
}

function toDebitXml(
  canonical: CanonicalInvoice = baseDebitCanonical(),
  billingReference: DebitNoteInput['billingReference'] = {
    invoiceDocumentReference: { id: 'INV-ORIG-002', issueDate: '2026-10-01' },
  },
): string {
  const semantic = canonicalToSemantic(canonical);
  const pintOm = semanticToPintOm(semantic);
  const input: DebitNoteInput = { ...pintOm, billingReference };
  return serializeDebitNote(input);
}

describe('serializeDebitNote — document shape (Peppol BIS 3.0 uses Invoice-2)', () => {
  const xml = toDebitXml();

  it('uses the Invoice-2 namespace, NOT DebitNote-2', () => {
    expect(xml).toContain('<Invoice ');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).not.toContain('<DebitNote ');
    expect(xml).not.toContain('schema:xsd:DebitNote-2');
  });

  it('carries InvoiceTypeCode 383 (debit-note discriminator)', () => {
    expect(xml).toContain('<cbc:InvoiceTypeCode>383</cbc:InvoiceTypeCode>');
  });

  it('includes cac:BillingReference back to the original invoice', () => {
    expect(xml).toContain('<cac:BillingReference>');
    expect(xml).toContain('<cac:InvoiceDocumentReference>');
    expect(xml).toContain('<cbc:ID>INV-ORIG-002</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-10-01</cbc:IssueDate>');
  });

  it('places BillingReference after DocumentCurrencyCode and before the parties', () => {
    const idx = (needle: string) => xml.indexOf(needle);
    expect(idx('<cbc:DocumentCurrencyCode>')).toBeLessThan(idx('<cac:BillingReference>'));
    expect(idx('<cac:BillingReference>')).toBeLessThan(idx('<cac:AccountingSupplierParty>'));
  });

  it('parseUbl accepts the serialised debit note as an Invoice', () => {
    const parsed = parseUbl(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.data.Invoice as Record<string, string>)['cbc:InvoiceTypeCode']).toBe('383');
  });

  it('is byte-identical across repeated serialisation', () => {
    expect(toDebitXml()).toBe(toDebitXml());
  });
});

describe('serializeDebitNote — guard rails', () => {
  it('throws when handed a semantic shape with a non-383 type code', () => {
    const semantic = canonicalToSemantic(baseDebitCanonical({ type: 'invoice' }));
    const pintOm = semanticToPintOm(semantic);
    const input: DebitNoteInput = {
      ...pintOm,
      billingReference: { invoiceDocumentReference: { id: 'X' } },
    };
    expect(() => serializeDebitNote(input)).toThrow(/bt3_typeCode='383'/);
  });

  it('escapes special XML characters in the billing reference id', () => {
    const xml = toDebitXml(baseDebitCanonical(), {
      invoiceDocumentReference: { id: 'INV<&>001' },
    });
    expect(xml).toContain('<cbc:ID>INV&lt;&amp;&gt;001</cbc:ID>');
  });
});

describe('serializeDebitNote — VAT math increase semantics', () => {
  it('amounts flow through unchanged (positive values representing the additional charge)', () => {
    const xml = toDebitXml();
    // 1 * 5 = 5.000 OMR, +5% = 5.250 OMR.
    expect(xml).toContain('currencyID="OMR">5.000</cbc:LineExtensionAmount>');
    expect(xml).toContain('currencyID="OMR">0.250</cbc:TaxAmount>');
    expect(xml).toContain('currencyID="OMR">5.250</cbc:PayableAmount>');
  });
});
