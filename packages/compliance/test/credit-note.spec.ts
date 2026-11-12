/**
 * Tests for the UBL CreditNote-2 serialiser.
 *
 * Mirrors ubl.spec.ts for Invoice, with the credit-note shape
 * differences:
 *   - Root element is <CreditNote>
 *   - cbc:CreditNoteTypeCode (not InvoiceTypeCode)
 *   - cac:BillingReference/cac:InvoiceDocumentReference is mandatory
 *   - Line container is cac:CreditNoteLine with cbc:CreditedQuantity
 */

import {
  canonicalToSemantic,
  parseCreditNote,
  PINT_OM_CUSTOMIZATION_ID,
  PINT_OM_PROFILE_ID,
  semanticToPintOm,
  serializeCreditNote,
  type CanonicalInvoice,
  type CreditNoteInput,
} from '../src/index.js';

function baseCreditCanonical(overrides: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    id: '00000000-0000-0000-0000-000000001001',
    type: 'credit_note',
    number: 'CN-UBL-0001',
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
        description: 'Widget refund',
        quantity: 2,
        unitCode: 'C62',
        unitPrice: 10,
        vatCategory: 'S',
        vatRate: 5,
      },
      {
        lineNo: 2,
        description: 'Gadget refund',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 30,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
    ...overrides,
  };
}

function toCreditNoteXml(
  canonical: CanonicalInvoice = baseCreditCanonical(),
  billingReference: CreditNoteInput['billingReference'] = {
    invoiceDocumentReference: { id: 'INV-ORIG-001', issueDate: '2026-10-01' },
  },
  documentUuid?: string,
): string {
  const semantic = canonicalToSemantic(canonical);
  const pintOm = semanticToPintOm(semantic, { documentUuid });
  const input: CreditNoteInput = { ...pintOm, billingReference };
  return serializeCreditNote(input);
}

describe('serializeCreditNote — document shape', () => {
  const xml = toCreditNoteXml();

  it('starts with the UTF-8 XML declaration', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  });

  it('uses the CreditNote-2 namespace on the root', () => {
    expect(xml).toContain('<CreditNote ');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(xml).toContain(
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    );
    expect(xml).toContain(
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    );
    expect(xml).not.toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
  });

  it('emits CreditNoteTypeCode 381, not InvoiceTypeCode', () => {
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).not.toContain('<cbc:InvoiceTypeCode>');
  });

  it('includes PINT-OM customization and profile identifiers', () => {
    expect(xml).toContain(`<cbc:CustomizationID>${PINT_OM_CUSTOMIZATION_ID}</cbc:CustomizationID>`);
    expect(xml).toContain(`<cbc:ProfileID>${PINT_OM_PROFILE_ID}</cbc:ProfileID>`);
  });

  it('includes the BillingReference back to the original invoice', () => {
    expect(xml).toContain('<cac:BillingReference>');
    expect(xml).toContain('<cac:InvoiceDocumentReference>');
    expect(xml).toContain('<cbc:ID>INV-ORIG-001</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-10-01</cbc:IssueDate>');
  });

  it('wraps lines in cac:CreditNoteLine with cbc:CreditedQuantity', () => {
    expect(xml).toContain('<cac:CreditNoteLine>');
    expect(xml).toContain('<cbc:CreditedQuantity');
    expect(xml).not.toContain('<cac:InvoiceLine>');
    expect(xml).not.toContain('<cbc:InvoicedQuantity');
  });

  it('parseCreditNote accepts the serialiser output', () => {
    const parsed = parseCreditNote(xml);
    expect(parsed.ok).toBe(true);
  });

  it('UBL document order: Customization -> Profile -> ID -> IssueDate -> CreditNoteTypeCode -> DocumentCurrencyCode -> BillingReference -> parties -> TaxTotal -> LegalMonetaryTotal -> CreditNoteLine', () => {
    const idx = (needle: string) => xml.indexOf(needle);
    expect(idx('<cbc:CustomizationID>')).toBeLessThan(idx('<cbc:ProfileID>'));
    expect(idx('<cbc:ProfileID>')).toBeLessThan(idx('<cbc:ID>'));
    expect(idx('<cbc:ID>')).toBeLessThan(idx('<cbc:IssueDate>'));
    expect(idx('<cbc:IssueDate>')).toBeLessThan(idx('<cbc:CreditNoteTypeCode>'));
    expect(idx('<cbc:CreditNoteTypeCode>')).toBeLessThan(idx('<cbc:DocumentCurrencyCode>'));
    expect(idx('<cbc:DocumentCurrencyCode>')).toBeLessThan(idx('<cac:BillingReference>'));
    expect(idx('<cac:BillingReference>')).toBeLessThan(idx('<cac:AccountingSupplierParty>'));
    expect(idx('<cac:AccountingSupplierParty>')).toBeLessThan(idx('<cac:AccountingCustomerParty>'));
    expect(idx('<cac:AccountingCustomerParty>')).toBeLessThan(idx('<cac:TaxTotal>'));
    expect(idx('<cac:TaxTotal>')).toBeLessThan(idx('<cac:LegalMonetaryTotal>'));
    expect(idx('<cac:LegalMonetaryTotal>')).toBeLessThan(idx('<cac:CreditNoteLine>'));
  });
});

describe('serializeCreditNote — determinism', () => {
  it('yields byte-identical output on two independent calls', () => {
    const a = toCreditNoteXml();
    const b = toCreditNoteXml();
    expect(a).toBe(b);
    expect(Buffer.byteLength(a, 'utf8')).toBe(Buffer.byteLength(b, 'utf8'));
  });
});

describe('serializeCreditNote — monetary formatting', () => {
  it('OMR amounts render with 3 decimal places', () => {
    const xml = toCreditNoteXml();
    // 2 * 10 = 20.000 line net, +30 = 50.000 total, +5% VAT = 52.500.
    expect(xml).toContain('currencyID="OMR">20.000</cbc:LineExtensionAmount>');
    expect(xml).toContain('currencyID="OMR">52.500</cbc:PayableAmount>');
  });

  it('USD amounts render with 2 decimal places', () => {
    const xml = toCreditNoteXml(baseCreditCanonical({ currency: 'USD' }));
    expect(xml).toContain('currencyID="USD">20.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('currencyID="USD">52.50</cbc:PayableAmount>');
  });

  it('every monetary element carries a currencyID attribute', () => {
    const xml = toCreditNoteXml();
    const monetary = [
      'cbc:LineExtensionAmount',
      'cbc:TaxAmount',
      'cbc:TaxableAmount',
      'cbc:TaxExclusiveAmount',
      'cbc:TaxInclusiveAmount',
      'cbc:PayableAmount',
      'cbc:PriceAmount',
    ];
    for (const tag of monetary) {
      const opens = xml.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
      expect(opens.length).toBeGreaterThan(0);
      for (const open of opens) {
        expect(open).toContain('currencyID=');
      }
    }
  });
});

describe('serializeCreditNote — VAT math reversal semantics', () => {
  it('matches the reversing invoice line totals that upstream computes', () => {
    // The serialiser does not negate; its contract is that whatever the
    // service layer has computed is emitted. For a credit note that
    // fully reverses INV-ORIG, the service layer feeds positive line
    // amounts and the "credit nature" is carried by the document type
    // code 381. This is the Peppol BIS Billing 3.0 convention.
    const xml = toCreditNoteXml();
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('currencyID="OMR">50.000</cbc:LineExtensionAmount>'); // sum
    expect(xml).toContain('currencyID="OMR">2.500</cbc:TaxAmount>'); // 5% VAT
    expect(xml).toContain('currencyID="OMR">52.500</cbc:TaxInclusiveAmount>');
  });

  it('round-trips through parseCreditNote and exposes the billing reference', () => {
    const xml = toCreditNoteXml();
    const parsed = parseCreditNote(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cn = parsed.data.CreditNote as Record<string, Record<string, unknown>>;
    const ref = cn['cac:BillingReference'] as Record<string, Record<string, unknown>>;
    const docRef = ref['cac:InvoiceDocumentReference'];
    expect(docRef['cbc:ID']).toBe('INV-ORIG-001');
    expect(docRef['cbc:IssueDate']).toBe('2026-10-01');
  });
});

describe('parseCreditNote — negative cases', () => {
  it('rejects a non-CreditNote root element', () => {
    const res = parseCreditNote('<?xml version="1.0"?><NotACreditNote/>');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('CreditNote');
  });

  it('lists every missing mandatory element', () => {
    const skeleton =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2">' +
      '<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">X</cbc:ID>' +
      '</CreditNote>';
    const res = parseCreditNote(skeleton);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toEqual(
        expect.arrayContaining([
          'CreditNote/cbc:CustomizationID',
          'CreditNote/cbc:ProfileID',
          'CreditNote/cbc:IssueDate',
          'CreditNote/cbc:CreditNoteTypeCode',
          'CreditNote/cbc:DocumentCurrencyCode',
          'CreditNote/cac:BillingReference',
          'CreditNote/cac:LegalMonetaryTotal',
          'CreditNote/cac:CreditNoteLine',
        ]),
      );
    }
  });
});
